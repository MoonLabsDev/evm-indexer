import { analyzeAbi, isIdentifier, ParamInfo } from './abi';

const TS_RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else',
  'enum', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof',
  'new', 'null', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'let', 'static', 'implements', 'interface', 'package', 'private', 'protected',
  'public', 'await', 'arguments', 'eval',
]);

function key(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

function objectType(list: ParamInfo[]): string {
  return `{ ${list.map((p) => `${key(p.name)}: ${p.tsType}`).join('; ')} }`;
}

function paramName(p: ParamInfo, i: number): string {
  // Unnamed inputs come through as _0, _1; invalid or reserved names fall back to the same form.
  return isIdentifier(p.name) && !TS_RESERVED.has(p.name) ? p.name : `_${i}`;
}

/** Every name `emitContract` exports: the class, the event types and the events interface. */
export function contractExports(contractName: string, abi: unknown[]): string[] {
  const { events } = analyzeAbi(contractName, abi);
  return [contractName, `${contractName}Events`, ...events.map((e) => `${contractName}${e.name}Event`)];
}

/** Emits the TypeScript source of one contract class. */
export function emitContract(contractName: string, abi: unknown[], runtimeImport: string): string {
  const { functions, events } = analyzeAbi(contractName, abi);
  const L: string[] = [];

  // type-only names in their own import: clients may compile with verbatimModuleSyntax
  L.push(
    `import { BaseContract } from '${runtimeImport}';`,
    `import type { IndexedEvent, EventDef } from '${runtimeImport}';`,
    '',
  );

  for (const e of events) {
    L.push(`export type ${contractName}${e.name}Event = IndexedEvent<${e.inputs.length ? objectType(e.inputs) : '{}'}>;`);
  }
  L.push('', `export interface ${contractName}Events {`);
  for (const e of events) L.push(`  ${e.name}: ${contractName}${e.name}Event;`);
  L.push('}', '');

  L.push(`export class ${contractName} extends BaseContract {`);
  L.push(`  static readonly abi = ${JSON.stringify(abi, null, 2).replace(/\n/g, '\n  ')} as const;`);
  L.push(`  static readonly events: Record<keyof ${contractName}Events, EventDef> = {`);
  for (const e of events) {
    L.push(`    ${e.name}: { name: ${JSON.stringify(e.name)}, topic0: ${JSON.stringify(e.topic0)}, signature: ${JSON.stringify(e.signature)} },`);
  }
  L.push('  };');
  L.push(`  static readonly eventTypes = {} as ${contractName}Events;`);
  L.push(`  constructor(address: string) { super(address, ${contractName}.abi as unknown as unknown[]); }`);

  for (const f of functions) {
    const args = f.inputs.map((p, i) => `${paramName(p, i)}: ${p.tsType}`).join(', ');
    const names = f.inputs.map(paramName).join(', ');
    const ret =
      f.outputs.length === 0 ? 'void' : f.outputs.length === 1 ? f.outputs[0].tsType : objectType(f.outputs);
    L.push(`  ${f.name}(${args}): Promise<${ret}> { return this._call(${JSON.stringify(f.signature)}, [${names}]) as Promise<${ret}>; }`);
  }
  L.push('}', '');
  return L.join('\n');
}
