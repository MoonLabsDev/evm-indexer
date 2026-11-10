import type { RpcTransport } from '../../src/rpc/transport';

type Handler = (params: unknown[]) => unknown;

/** In-memory RpcTransport: handlers per method, every call recorded. A handler may throw. */
export class FakeTransport implements RpcTransport {
  calls: { method: string; params: unknown[] }[] = [];
  private handlers = new Map<string, Handler>();

  constructor(readonly url: string) {}

  on(method: string, handler: Handler): this {
    this.handlers.set(method, handler);
    return this;
  }

  async send(method: string, params: unknown[]): Promise<unknown> {
    this.calls.push({ method, params });
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`FakeTransport ${this.url}: no handler for ${method}`);
    return handler(params);
  }

  async sendBatch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const c of calls) out.push(await this.send(c.method, c.params));
    return out;
  }
}
