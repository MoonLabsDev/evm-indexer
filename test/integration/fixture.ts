import { readFileSync } from 'fs';
import { join } from 'path';

/** Paths and endpoints of the integration fixture, shared by globalSetup and the tests. */
export const ROOT = join(__dirname, '..', '..');
export const FIXTURE = join(ROOT, 'test', 'fixture');
export const PROJECT = join(FIXTURE, 'project');
export const RPC_PORT = 8546;
export const RPC_URL = `http://127.0.0.1:${RPC_PORT}`;
export const CHAIN_ID = 31337;

/** The compiled hardhat artifact (abi + bytecode) of a fixture contract. */
export function artifact(name: string): { abi: unknown[]; bytecode: string } {
  return JSON.parse(readFileSync(join(FIXTURE, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`), 'utf8'));
}
