import { resolve } from 'path';
import { ConfigError } from './chains';
import type { NormalizedConfig } from '../runtime/define';

/** Loads `indexer.config.ts` through tsx; its default export must be a `defineIndexer` result. */
export function loadIndexerConfig(path: string): NormalizedConfig {
  const file = resolve(path);
  const tsx = require('tsx/cjs/api') as { require(id: string, fromFile: string): unknown };
  let mod: unknown;
  try {
    mod = tsx.require(file, __filename);
  } catch (e) {
    throw new ConfigError(`cannot load ${file}: ${(e as Error).message}`);
  }
  const cfg = ((mod as { default?: unknown } | null)?.default ?? mod) as { sources?: unknown } | null;
  if (!cfg || typeof cfg.sources !== 'object' || cfg.sources === null) {
    throw new ConfigError(`${file} must default-export the result of defineIndexer()`);
  }
  return cfg as NormalizedConfig;
}
