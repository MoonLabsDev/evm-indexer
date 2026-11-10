import { resolve } from 'path';
import { ConfigError } from './chains';
import type { NormalizedConfig } from '../runtime/define';

let tsxRegistered = false;

/**
 * Registers tsx as a global require hook, once per process, and keeps it registered so handlers
 * can still import .ts files lazily. A plain `require` then loads the config and everything it
 * imports into the same module cache as the CLI: `import 'evm-indexer'` in a client project reaches
 * the one runtime copy whose context, RPC handle, entity store and template sink the CLI sets.
 * (tsx's namespaced `tsx.require` would cache a second copy of the package under `?namespace=`.)
 */
function registerTsx(): void {
  if (tsxRegistered) return;
  const { register } = require('tsx/cjs/api') as { register(): unknown };
  register();
  tsxRegistered = true;
}

/** Loads `indexer.config.ts` through tsx; its default export must be a `defineIndexer` result. */
export function loadIndexerConfig(path: string): NormalizedConfig {
  const file = resolve(path);
  registerTsx();
  let mod: unknown;
  try {
    mod = require(file);
  } catch (e) {
    throw new ConfigError(`cannot load ${file}: ${(e as Error).message}`);
  }
  const cfg = ((mod as { default?: unknown } | null)?.default ?? mod) as { sources?: unknown } | null;
  if (!cfg || typeof cfg.sources !== 'object' || cfg.sources === null) {
    throw new ConfigError(`${file} must default-export the result of defineIndexer()`);
  }
  return cfg as NormalizedConfig;
}
