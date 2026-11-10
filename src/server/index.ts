import express from 'express';

/** A heartbeat younger than this (ms) counts as fresh. */
const HEARTBEAT_FRESH_MS = 60_000;

export interface ServerOptions {
  port: number;
  status: () => object;
  lastLoopAt: () => number;
  now?: () => number;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * Starts the status server: `GET /health` (200 ok / 503 stale) and `GET /status` (JSON).
 * Resolves with the actually bound port once listening; rejects on listen errors.
 */
export function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const now = opts.now ?? Date.now;
  const app = express();

  app.get('/health', (_req, res) => {
    if (now() - opts.lastLoopAt() < HEARTBEAT_FRESH_MS) res.status(200).send('ok');
    else res.status(503).send('stale');
  });

  app.get('/status', (_req, res) => {
    try {
      res.status(200).json(opts.status());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(opts.port);
    server.once('error', reject);
    server.once('listening', () => {
      server.off('error', reject);
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done, fail) => {
            if (!server.listening) return done();
            server.close((err) => (err ? fail(err) : done()));
            server.closeAllConnections();
          }),
      });
    });
  });
}
