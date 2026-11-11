import { existsSync } from 'node:fs';
import { basename, extname, join, dirname, resolve } from 'node:path';
import { ConfigError } from './errors';
import type { ConfigKind } from '../runtime/define';

let tsxRegistered = false;

/**
 * Registers tsx as a global require hook, once per process, and keeps it registered so handlers
 * can still import .ts files lazily. A plain `require` then loads the config and everything it
 * imports into the same module cache as the CLI: `import 'evm-indexer'` in a client project reaches
 * the one runtime copy whose context, RPC handle, entity store and template sink the CLI sets.
 * (tsx's namespaced `tsx.require` would cache a second copy of the package under `?namespace=`.)
 */
export function registerTsx(): void {
  if (tsxRegistered) return;
  const { register } = require('tsx/cjs/api') as { register(): unknown };
  register();
  tsxRegistered = true;
}

const HELPER: Record<ConfigKind, string> = {
  chains: 'defineChains',
  schema: 'defineSchema',
  addresses: 'defineAddresses',
};

/**
 * Requires `path` through tsx and returns the `value` of its default export, which must be tagged
 * `kind` by the matching define helper. The tag is checked structurally (a plain string property)
 * because the file may load a different copy of the runtime than the caller.
 */
export function loadTsDefault(path: string, kind: ConfigKind): unknown {
  const file = resolve(path);
  const helper = HELPER[kind];
  if (!existsSync(file)) {
    const ext = extname(file);
    const base = basename(file, ext);
    if (ext === '.ts' && existsSync(join(dirname(file), `${base}.json`))) {
      throw new ConfigError(
        `${file} not found; ${base}.json is no longer read: move it to ${base}.ts with export default ${helper}(...)`,
      );
    }
    throw new ConfigError(`cannot read ${file}: file not found`);
  }
  registerTsx();
  let mod: unknown;
  try {
    mod = require(file);
  } catch (e) {
    throw new ConfigError(`cannot load ${file}: ${(e as Error).message}`);
  }
  const def = ((mod as { default?: unknown } | null)?.default ?? mod) as { __evmIndexerConfig?: unknown; value?: unknown } | null;
  if (!def || typeof def !== 'object' || def.__evmIndexerConfig !== kind) {
    throw new ConfigError(`${file} must default-export the result of ${helper}()`);
  }
  return def.value;
}
