import { afterEach, describe, expect, it } from 'vitest';
import { startServer } from '../../src/server';

type Handle = Awaited<ReturnType<typeof startServer>>;

describe('status server', () => {
  const handles: Handle[] = [];
  const start = async (opts: Partial<Parameters<typeof startServer>[0]> = {}): Promise<Handle> => {
    const h = await startServer({
      port: 0,
      status: () => ({}),
      lastLoopAt: () => 1_000_000,
      now: () => 1_000_000,
      ...opts,
    });
    handles.push(h);
    return h;
  };

  afterEach(async () => {
    await Promise.all(handles.splice(0).map((h) => h.close()));
  });

  it('GET /health returns 200 ok for a fresh loop', async () => {
    const { port } = await start({ lastLoopAt: () => 1_000_000 - 1_000 });
    expect(port).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /health returns 503 stale when the loop is 61 s old', async () => {
    const { port } = await start({ lastLoopAt: () => 1_000_000 - 61_000 });
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('stale');
  });

  it('GET /status returns the status() object verbatim', async () => {
    const obj = { chains: [{ chainId: 1, indexedBlock: 5 }], running: true };
    const { port } = await start({ status: () => obj });
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(obj);
  });

  it('GET /status responds 500 with the error message when status() throws', async () => {
    const { port } = await start({
      status: () => {
        throw new Error('boom');
      },
    });
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  it('unknown path returns 404', async () => {
    const { port } = await start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });

  it('rejects when the port is already in use', async () => {
    const { port } = await start();
    await expect(
      startServer({ port, status: () => ({}), lastLoopAt: () => 0 }),
    ).rejects.toThrow();
  });

  it('close() stops the server', async () => {
    const h = await start();
    await h.close();
    await expect(fetch(`http://127.0.0.1:${h.port}/health`)).rejects.toThrow();
  });
});
