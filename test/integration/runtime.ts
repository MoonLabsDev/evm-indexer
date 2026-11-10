import { createRequire } from 'module';
import { join } from 'path';
import { ROOT } from './fixture';

/*
 * Runtime singleton in tests: loadIndexerConfig loads indexer.config.ts (and through it the generated
 * code, the handlers and src/index) with tsx's require, which keeps its own module instances apart
 * from the ones vitest loads for a test file. A test that imported Indexer or Processor directly would
 * install the context, RPC handle, entity store and template sink in vitest's copy of src/runtime,
 * while the callbacks read tsx's copy. So every src module the e2e test uses comes through the same
 * tsx require as the config. (In a real project both sides resolve to one dist/ copy.)
 */
const tsx = createRequire(__filename)('tsx/cjs/api') as { require(id: string, fromFile: string): unknown };
const load = <T>(rel: string): T => tsx.require(join(ROOT, rel), __filename) as T;

export const { loadIndexerConfig } = load<typeof import('../../src/config/indexerConfig')>('src/config/indexerConfig.ts');
export const { loadChain } = load<typeof import('../../src/config/chains')>('src/config/chains.ts');
export const { loadAddresses } = load<typeof import('../../src/config/addresses')>('src/config/addresses.ts');
export const { HttpTransport } = load<typeof import('../../src/rpc/transport')>('src/rpc/transport.ts');
export const { RpcPool } = load<typeof import('../../src/rpc/pool')>('src/rpc/pool.ts');
export const { SystemStore } = load<typeof import('../../src/store/system')>('src/store/system.ts');
export const { EntityStore } = load<typeof import('../../src/store/entities')>('src/store/entities.ts');
export const { Indexer } = load<typeof import('../../src/indexer/indexer')>('src/indexer/indexer.ts');
export const { Processor } = load<typeof import('../../src/processor/processor')>('src/processor/processor.ts');
export const { cmdReset, cmdSetRevision } = load<typeof import('../../src/cli/commands')>('src/cli/commands.ts');

/** A module of the fixture project, from the same module instances as the loaded config. */
export function loadProjectModule<T>(rel: string): T {
  return load<T>(join('test', 'fixture', 'project', rel));
}
