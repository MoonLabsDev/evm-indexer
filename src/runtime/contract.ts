import { Interface } from 'ethers';
import { block } from './context';
import { normalizeValue } from './events';

/** Structural type so the runtime does not depend on src/rpc. */
export interface EthCaller {
  ethCall(to: string, data: string, blockNumber: number): Promise<string>;
}

let rpc: EthCaller | null = null;

export function setRpc(pool: EthCaller | null): void {
  rpc = pool;
}

export class BaseContract {
  readonly address: string;
  protected readonly _iface: Interface;

  constructor(address: string, abi: unknown[]) {
    this.address = address.toLowerCase();
    this._iface = new Interface(abi as never);
  }

  /** eth_call at the current context block; the function is looked up by its full signature. */
  protected async _call(signature: string, args: unknown[]): Promise<unknown> {
    const blockNumber = block().number; // throws ContextError outside a callback
    if (!rpc) throw new Error('RPC is not configured: setRpc() has not been called');
    const fragment = this._iface.getFunction(signature);
    if (!fragment) throw new Error(`Unknown function ${signature}`);
    const data = this._iface.encodeFunctionData(fragment, args);
    const raw = await rpc.ethCall(this.address, data, blockNumber);
    const decoded = this._iface.decodeFunctionResult(fragment, raw);
    const outputs = fragment.outputs.map((p, i) => normalizeValue(decoded[i], p));
    if (outputs.length === 1) return outputs[0];
    const out: Record<string, unknown> = {};
    fragment.outputs.forEach((p, i) => {
      out[p.name || `_${i}`] = outputs[i];
    });
    return out;
  }
}
