import { describe, it, expect } from 'vitest';
import { classifyError, RpcError } from '../../src/rpc/errors';

describe('classifyError', () => {
  it('classifies reverts as fatal even when the text says "exceeds"', () => {
    expect(classifyError(new RpcError('execution reverted: transfer amount exceeds balance', 3))).toBe('fatal');
    expect(classifyError(new Error('VM Exception: revert, exceeds'))).toBe('fatal');
  });

  it('lets a 429 win over message text', () => {
    expect(classifyError(new RpcError('upstream timeout exceeded', undefined, 429))).toBe('rateLimit');
  });

  it('lets a 5xx win over message text', () => {
    expect(classifyError(new RpcError('request timeout, limit exceeded', undefined, 503))).toBe('network');
  });

  it('classifies the basic kinds', () => {
    const abort = new Error('x');
    abort.name = 'AbortError';
    expect(classifyError(abort)).toBe('timeout');
    expect(classifyError(new RpcError('Too Many Requests'))).toBe('rateLimit');
    expect(classifyError(new RpcError('whatever', -32005))).toBe('tooLarge');
    expect(classifyError(new RpcError('method not found', -32601))).toBe('unsupported');
    expect(classifyError(new TypeError('fetch failed'))).toBe('network');
    expect(classifyError(new RpcError('invalid params', -32602))).toBe('fatal');
  });
});
