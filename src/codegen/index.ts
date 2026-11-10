import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { analyzeAbi } from './abi';
import { emitContract } from './contracts';
import { emitEntity } from './entities';
import { parseSchema } from './schema';

export interface CodegenOptions {
  abiDir: string;
  schemaPath: string;
  outDir: string;
  /** Module the generated files import the runtime from. Defaults to the package name. */
  runtimeImport?: string;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${(e as Error).message}`);
  }
}

/** An ABI file is a plain array or an artifact object (hardhat, foundry) holding an `abi` array. */
function extractAbi(file: string, json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  const abi = (json as { abi?: unknown } | null)?.abi;
  if (Array.isArray(abi)) return abi;
  throw new Error(`${file}: expected an ABI array or an object with an "abi" array`);
}

/**
 * Generates contract and entity classes. Everything is validated and emitted in memory first,
 * so a failure leaves the output directory untouched.
 */
export function runCodegen(opts: CodegenOptions): { files: string[]; warnings: string[] } {
  const runtimeImport = opts.runtimeImport ?? 'evm-indexer';
  if (!existsSync(opts.abiDir)) throw new Error(`ABI directory not found: ${opts.abiDir}`);

  const sources = new Map<string, string>(); // path relative to outDir -> content
  const warnings: string[] = [];
  const contracts: string[] = [];

  const abiFiles = readdirSync(opts.abiDir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  for (const file of abiFiles) {
    const name = basename(file, file.slice(-5));
    const path = join(opts.abiDir, file);
    const abi = extractAbi(path, readJson(path));
    try {
      warnings.push(...analyzeAbi(name, abi).warnings);
      sources.set(`contracts/${name}.ts`, emitContract(name, abi, runtimeImport));
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
    contracts.push(name);
  }

  const tables: string[] = [];
  if (existsSync(opts.schemaPath)) {
    let schema;
    try {
      schema = parseSchema(readJson(opts.schemaPath));
    } catch (e) {
      throw new Error(`${opts.schemaPath}: ${(e as Error).message}`);
    }
    for (const [table, fields] of Object.entries(schema)) {
      if (contracts.includes(table)) {
        throw new Error(`Table "${table}" has the same name as contract "${table}"; both are exported from generated/index.ts`);
      }
      sources.set(`entities/${table}.ts`, emitEntity(table, fields, runtimeImport));
      tables.push(table);
    }
  }

  sources.set(
    'index.ts',
    [...contracts.map((c) => `export * from './contracts/${c}';`), ...tables.map((t) => `export * from './entities/${t}';`)].join('\n') + '\n',
  );

  const files: string[] = [];
  for (const [rel, content] of sources) {
    const target = join(opts.outDir, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    files.push(target);
  }
  return { files, warnings };
}
