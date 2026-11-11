import type { StaticEntry } from '../types';
import { ConfigError, isRecord } from './chains';
import { loadTsDefault } from './load';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Expands the addresses config entries of one chain into lowercased StaticEntry rows. */
export function parseAddresses(json: unknown, chainId: number, contractNames: string[]): StaticEntry[] {
  if (!isRecord(json)) throw new ConfigError('addresses config must be an object keyed by chain id');
  const chain = json[String(chainId)];
  if (!isRecord(chain)) throw new ConfigError(`chain ${chainId} not found in addresses config`);
  for (const name of Object.keys(chain)) {
    if (!contractNames.includes(name)) throw new ConfigError(`chain ${chainId}: unknown contract "${name}"`);
  }
  const out: StaticEntry[] = [];
  for (const name of contractNames) {
    const entry = chain[name];
    if (!isRecord(entry)) throw new ConfigError(`chain ${chainId}: missing entry for contract "${name}"`);
    const { address, block } = entry;
    if (typeof block !== 'number' || !Number.isInteger(block) || block < 0) {
      throw new ConfigError(`chain ${chainId}: ${name}.block must be an integer >= 0`);
    }
    const list = Array.isArray(address) ? address : [address];
    if (list.length === 0) throw new ConfigError(`chain ${chainId}: ${name}.address must not be empty`);
    for (const a of list) {
      if (typeof a !== 'string' || !ADDRESS.test(a)) {
        throw new ConfigError(`chain ${chainId}: ${name}.address is not a valid address: ${String(a)}`);
      }
      out.push({ source: name, address: a.toLowerCase(), block });
    }
  }
  return out;
}

export function loadAddresses(path: string, chainId: number, contractNames: string[]): StaticEntry[] {
  return parseAddresses(loadTsDefault(path, 'addresses'), chainId, contractNames);
}
