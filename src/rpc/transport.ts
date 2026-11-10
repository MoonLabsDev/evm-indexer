import { RpcError } from './errors';

export interface RpcTransport {
  readonly url: string;
  send(method: string, params: unknown[]): Promise<unknown>;
  sendBatch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>;
}

interface JsonRpcResponse { id?: number; result?: unknown; error?: { code?: number; message?: string } }

export class HttpTransport implements RpcTransport {
  private nextId = 1;

  constructor(readonly url: string, private readonly timeoutMs = 30000) {}

  async send(method: string, params: unknown[]): Promise<unknown> {
    const res = (await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params })) as JsonRpcResponse;
    return this.unwrap(res);
  }

  async sendBatch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (calls.length === 0) return [];
    const base = this.nextId;
    this.nextId += calls.length;
    const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i, method: c.method, params: c.params }));
    const res = await this.post(body);
    if (!Array.isArray(res)) {
      // some nodes answer a failed batch with a single error object
      this.unwrap(res as JsonRpcResponse);
      throw new RpcError('fetch failed: batch answered with a single response', undefined, 502);
    }
    const byId = new Map<number, JsonRpcResponse>();
    for (const r of res as JsonRpcResponse[]) if (typeof r.id === 'number') byId.set(r.id, r);
    return calls.map((_, i) => {
      const r = byId.get(base + i);
      if (!r) throw new RpcError(`fetch failed: batch response missing id ${base + i}`, undefined, 502);
      return this.unwrap(r);
    });
  }

  private unwrap(res: JsonRpcResponse): unknown {
    if (res.error) throw new RpcError(res.error.message ?? 'rpc error', res.error.code);
    return res.result;
  }

  private async post(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new RpcError(await res.text(), undefined, res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
