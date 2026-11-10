import type { Timestamp } from './timestamp';

export class ContextError extends Error {
  constructor(message = 'No event context: this is only available inside an event callback') {
    super(message);
    this.name = 'ContextError';
  }
}

export interface ContextData {
  mode: 'index' | 'process';
  chain: { id: number; name: string };
  block: { number: number; hash: string; timestamp: Timestamp };
  tx: {
    hash: string; transactionIndex: number; logIndex: number; from: string; to: string | null;
    value: bigint; nonce: number; gasPrice: bigint; input: string;
  };
}

// Events are handled strictly one at a time, so a single variable is enough.
let current: ContextData | null = null;

export function setContext(c: ContextData): void {
  current = c;
}

export function clearContext(): void {
  current = null;
}

export function currentContext(): ContextData | null {
  return current;
}

function require_(): ContextData {
  if (!current) throw new ContextError();
  return current;
}

export function tx(): ContextData['tx'] {
  return require_().tx;
}

export function block(): ContextData['block'] {
  return require_().block;
}

export function chain(): ContextData['chain'] {
  return require_().chain;
}
