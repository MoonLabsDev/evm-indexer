import { readFileSync } from 'node:fs';
import type { ChainConfig, SizeBounds } from '../types';
import { ConfigError } from './errors';
import { loadTsDefault } from './load';

export { ConfigError };

/** Reads and parses a JSON file; missing or invalid files raise a ConfigError naming the path. */
export function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${path}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`cannot parse ${path}: ${(e as Error).message}`);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(where: string, v: unknown, def: number, min: number): number {
  if (v === undefined) return def;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw new ConfigError(`${where} must be an integer >= ${min}`);
  }
  return v;
}

function bounds(where: string, v: unknown, def: SizeBounds): SizeBounds {
  if (v === undefined) return { ...def };
  if (!isRecord(v)) throw new ConfigError(`${where} must be an object`);
  const b = {
    start: num(`${where}.start`, v.start, def.start, 1),
    min: num(`${where}.min`, v.min, def.min, 1),
    max: num(`${where}.max`, v.max, def.max, 1),
  };
  if (!(b.min <= b.start && b.start <= b.max)) {
    throw new ConfigError(`${where} must satisfy 1 <= min <= start <= max`);
  }
  return b;
}

function parseChain(id: string, raw: unknown): ChainConfig {
  if (!/^[1-9]\d*$/.test(id)) throw new ConfigError(`invalid chain id "${id}"`);
  const where = `chain ${id}`;
  if (!isRecord(raw)) throw new ConfigError(`${where} must be an object`);
  if (typeof raw.name !== 'string' || raw.name === '') throw new ConfigError(`${where}: name must be a non-empty string`);
  if (!Array.isArray(raw.rpc) || raw.rpc.length === 0 || !raw.rpc.every((u) => typeof u === 'string' && u !== '')) {
    throw new ConfigError(`${where}: rpc must be a non-empty array of URLs`);
  }
  let retryDelays = [100, 500, 2500];
  if (raw.retryDelays !== undefined) {
    if (!Array.isArray(raw.retryDelays) || !raw.retryDelays.every((d) => typeof d === 'number' && Number.isFinite(d) && d >= 0)) {
      throw new ConfigError(`${where}: retryDelays must be an array of non-negative numbers`);
    }
    retryDelays = raw.retryDelays as number[];
  }
  if (raw.useBloom !== undefined && typeof raw.useBloom !== 'boolean') {
    throw new ConfigError(`${where}: useBloom must be a boolean`);
  }
  return {
    chainId: Number(id),
    name: raw.name,
    rpc: raw.rpc as string[],
    confirmations: num(`${where}: confirmations`, raw.confirmations, 0, 0),
    retryDelays,
    logRange: bounds(`${where}: logRange`, raw.logRange, { start: 500, min: 1, max: 2000 }),
    blockBatch: bounds(`${where}: blockBatch`, raw.blockBatch, { start: 10, min: 1, max: 100 }),
    headThreshold: num(`${where}: headThreshold`, raw.headThreshold, 64, 0),
    useBloom: (raw.useBloom as boolean | undefined) ?? true,
    pollInterval: num(`${where}: pollInterval`, raw.pollInterval, 1000, 1),
  };
}

/** Validates a chains config object and applies defaults. */
export function parseChains(json: unknown): Record<string, ChainConfig> {
  if (!isRecord(json)) throw new ConfigError('chains config must be an object keyed by chain id');
  const out: Record<string, ChainConfig> = {};
  for (const [id, raw] of Object.entries(json)) out[id] = parseChain(id, raw);
  return out;
}

export function loadChain(path: string, chainId: number): ChainConfig {
  const chains = parseChains(loadTsDefault(path, 'chains'));
  const c = chains[String(chainId)];
  if (!c) throw new ConfigError(`chain ${chainId} not found in ${path}`);
  return c;
}
