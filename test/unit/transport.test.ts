import { describe, it, expect, vi, afterEach } from 'vitest';
import { HttpTransport } from '../../src/rpc/transport';
import { RpcError, classifyError } from '../../src/rpc/errors';

const reply = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }));
afterEach(() => vi.unstubAllGlobals());

async function failure(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error('expected rejection');
}

describe('HttpTransport', () => {
  it('returns the result member', async () => {
    vi.stubGlobal('fetch', reply('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
    expect(await new HttpTransport('http://x').send('eth_blockNumber', [])).toBe('0x1');
  });

  it('turns a JSON-RPC error member into RpcError with code', async () => {
    vi.stubGlobal('fetch', reply('{"id":1,"error":{"code":-32005,"message":"too big"}}'));
    const e = await failure(new HttpTransport('http://x').send('eth_getLogs', []));
    expect(e).toBeInstanceOf(RpcError);
    expect(e.code).toBe(-32005);
    expect(e.message).toBe('too big');
  });

  it('turns a non-2xx response into RpcError with status, also for an empty body', async () => {
    vi.stubGlobal('fetch', reply('', 503));
    const e = await failure(new HttpTransport('http://x').send('m', []));
    expect(e.status).toBe(503);
    expect(e.message).toContain('503');
    expect(classifyError(e)).toBe('network');
  });

  it('maps an out-of-order batch reply by id', async () => {
    vi.stubGlobal('fetch', reply('[{"id":2,"result":"b"},{"id":1,"result":"a"}]'));
    const t = new HttpTransport('http://x');
    expect(await t.sendBatch([{ method: 'm', params: [] }, { method: 'm', params: [] }])).toEqual(['a', 'b']);
  });

  it('treats a missing id in a batch reply as retryable', async () => {
    vi.stubGlobal('fetch', reply('[{"id":1,"result":"a"}]'));
    const t = new HttpTransport('http://x');
    const e = await failure(t.sendBatch([{ method: 'm', params: [] }, { method: 'm', params: [] }]));
    expect(e.status).toBe(502);
    expect(classifyError(e)).toBe('network');
  });

  it('treats a non-JSON 200 body as retryable', async () => {
    for (const body of ['<html>bad gateway</html>', '']) {
      vi.stubGlobal('fetch', reply(body));
      const e = await failure(new HttpTransport('http://x').send('m', []));
      expect(e).toBeInstanceOf(RpcError);
      expect(e.status).toBe(502);
      expect(classifyError(e)).toBe('network');
    }
  });

  it('classifies an aborted request as timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })));
    const e = await failure(new HttpTransport('http://x', 10).send('m', []));
    expect(classifyError(e)).toBe('timeout');
  });
});
