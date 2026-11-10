import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { analyzeAbi } from './abi';
import { contractExports, emitContract } from './contracts';
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
  const exported = new Map<string, string>(); // name exported by a contract file -> contract

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
    for (const n of contractExports(name, abi)) exported.set(n, name);
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
      const clash = exported.get(table);
      if (clash !== undefined && clash !== table) {
        throw new Error(`Table "${table}" has the same name as a type exported by contract "${clash}"; rename the table`);
      }
      sources.set(`entities/${table}.ts`, emitEntity(table, fields, runtimeImport));
      tables.push(table);
    }
  }

  // An entity named like a contract is exported from the index as <Name>Entity.
  const entityExports = new Map<string, string>(); // exported name -> table
  for (const table of tables) {
    let name = table;
    if (contracts.includes(table)) {
      name = `${table}Entity`;
      const other = exported.get(name) ?? (tables.includes(name) ? name : undefined);
      if (other !== undefined) {
        throw new Error(
          `Entity "${table}" would be exported as "${name}", which collides with ${
            exported.has(name) ? `contract "${exported.get(name)}"` : `table "${name}"`}; rename one of them`,
        );
      }
      warnings.push(`entity ${table} is exported from ./generated as ${name} (contract ${table} has the same name)`);
    }
    entityExports.set(name, table);
  }

  const barrel = (lines: string[]) => (lines.length > 0 ? lines.join('\n') : 'export {};') + '\n';
  sources.set('contracts/index.ts', barrel(contracts.map((c) => `export * from './${c}';`)));
  sources.set('entities/index.ts', barrel(tables.map((t) => `export * from './${t}';`)));
  sources.set(
    'index.ts',
    [
      "export * from './contracts';",
      ...[...entityExports].map(([name, table]) =>
        name === table ? `export { ${table} } from './entities/${table}';` : `export { ${table} as ${name} } from './entities/${table}';`),
    ].join('\n') + '\n',
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
