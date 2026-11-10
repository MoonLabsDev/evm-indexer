export type ErrorKind = 'timeout' | 'rateLimit' | 'tooLarge' | 'network' | 'unsupported' | 'fatal';

export class RpcError extends Error {
  constructor(msg: string, public code?: number, public status?: number) {
    super(msg);
    this.name = 'RpcError';
  }
}

/** A sized call was halved; the caller re-chunks and calls again. */
export class ResizeError extends Error {
  constructor(msg = 'request size reduced, retry with the smaller size') {
    super(msg);
    this.name = 'ResizeError';
  }
}

export class AllRpcFailedError extends Error {
  constructor(msg = 'all RPC endpoints failed') {
    super(msg);
    this.name = 'AllRpcFailedError';
  }
}

interface ErrorLike { name?: unknown; message?: unknown; code?: unknown; status?: unknown; cause?: unknown }

const NETWORK_CODES = ['ECONNRESET', 'ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'];

export function classifyError(err: unknown): ErrorKind {
  const e = (typeof err === 'object' && err !== null ? err : { message: String(err) }) as ErrorLike;
  const msg = typeof e.message === 'string' ? e.message : '';
  const code = typeof e.code === 'number' ? e.code : undefined;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const strCode = typeof e.code === 'string' ? e.code : '';
  const cause = e.cause as ErrorLike | undefined;
  const causeCode = typeof cause?.code === 'string' ? cause.code : '';

  // HTTP status first: a 429/5xx body may mention anything
  if (status === 429) return 'rateLimit';
  if (status !== undefined && status >= 500) return 'network';
  if (e.name === 'AbortError' || /timeout/i.test(msg)) return 'timeout';
  // reverts are final, even when their text contains words like "exceeds"
  if (code === 3 || /revert/i.test(msg)) return 'fatal';
  if (/rate limit|too many requests/i.test(msg)) return 'rateLimit';
  if (code === -32005 || /too large|too many results|exceed|limit.*range|response size/i.test(msg)) return 'tooLarge';
  if (code === -32601 || /method not found|not supported/i.test(msg)) return 'unsupported';
  if (
    NETWORK_CODES.includes(strCode) || NETWORK_CODES.includes(causeCode) ||
    /ECONNRESET|ENOTFOUND|fetch failed/i.test(msg)
  ) return 'network';
  return 'fatal';
}
