#!/usr/bin/env node
import 'dotenv/config';
import { join } from 'path';
import { Command } from 'commander';
import { config as loadEnv } from 'dotenv';
import { ConfigError } from '../config/chains';
import { log, setDebug } from '../log';
import {
  cmdCodegen, cmdIndex, cmdProcess, cmdReset, cmdSetRevision, connectFromEnv, resolveChainId, runShutdown,
} from './commands';

interface GlobalOpts { debug?: boolean; root: string }

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('evm-indexer')
    .description('Subgraph-like EVM event indexer')
    .option('--debug', 'verbose logs: per event and per RPC retry')
    .option('--root <dir>', 'project directory with chains.json, addresses.json, ...', process.cwd());

  const globals = (): GlobalOpts => program.opts<GlobalOpts>();
  const paths = () => ({ root: globals().root });
  const chainOf = (flag?: string) => resolveChainId(flag, process.env);

  program.hook('preAction', () => {
    const g = globals();
    setDebug(g.debug === true);
    // The project's own .env in addition to the one in the working directory; never overrides.
    loadEnv({ path: join(g.root, '.env'), quiet: true });
  });

  program.command('codegen').description('generate generated/ from abis/ and schema.json')
    .action(() => cmdCodegen(paths()));

  program.command('index').description('run the indexer for one chain')
    .option('--chain <id>', 'chain id (default: CHAIN_ID)')
    .action(async (o: { chain?: string }) => { await cmdIndex(paths(), chainOf(o.chain)); });

  program.command('process').description('run the processor for one chain')
    .option('--chain <id>', 'chain id (default: CHAIN_ID)')
    .action(async (o: { chain?: string }) => { await cmdProcess(paths(), chainOf(o.chain)); });

  program.command('set-revision').description('set the revision of a chain (default: current + 1); the processor wipes entities and replays')
    .option('--chain <id>', 'chain id (default: CHAIN_ID)')
    .option('--revision <n>', 'revision id to set')
    .action(async (o: { chain?: string; revision?: string }) => {
      const chainId = chainOf(o.chain);
      if (o.revision !== undefined && !/^\d+$/.test(o.revision)) {
        throw new ConfigError(`invalid revision "${o.revision}": expected an integer >= 0`);
      }
      const { client, db } = await connectFromEnv();
      try {
        const id = await cmdSetRevision(db, chainId, o.revision === undefined ? undefined : Number(o.revision));
        log.result(String(id));
      } finally {
        await client.close();
      }
    });

  program.command('reset').description("delete all data, or only one chain's data with --chain")
    .option('--chain <id>', 'only this chain (default: everything; CHAIN_ID is not used here)')
    .option('--yes', 'skip the confirmation')
    .action(async (o: { chain?: string; yes?: boolean }) => {
      const chainId = o.chain === undefined ? undefined : resolveChainId(o.chain, {});
      const { client, db } = await connectFromEnv();
      try {
        const done = await cmdReset(db, { chainId, yes: o.yes === true });
        log.result(done ? 'reset done' : 'cancelled');
      } finally {
        await client.close();
      }
    });

  return program;
}

async function main(): Promise<void> {
  const program = buildProgram();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.step('Shut down');
    void runShutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const debug = program.opts<GlobalOpts>().debug === true;
    const message = err instanceof Error ? err.message : String(err);
    log.error(message, debug ? err : undefined);
    await runShutdown();
    process.exit(1);
  }
}

if (require.main === module) void main();
