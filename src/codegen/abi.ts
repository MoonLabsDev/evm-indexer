import { Interface, ParamType } from 'ethers';

export interface ParamInfo { name: string; tsType: string }
export interface FnInfo { name: string; signature: string; selector: string; inputs: ParamInfo[]; outputs: ParamInfo[] }
export interface EventInfo { name: string; signature: string; topic0: string; inputs: ParamInfo[] }

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Instance members of BaseContract that a generated method must not shadow. */
const RESERVED = new Set(['address', '_call', '_iface', 'constructor']);

export function isIdentifier(s: string): boolean {
  return IDENT.test(s);
}

function keyOf(name: string): string {
  return isIdentifier(name) ? name : JSON.stringify(name);
}

/** Solidity type to TypeScript type. Indexed dynamic event args are only a topic hash, hence string. */
export function solidityToTs(param: ParamType): string {
  const base = param.baseType;
  if (param.indexed && (base === 'string' || base === 'bytes' || base === 'array' || base === 'tuple')) {
    return 'string';
  }
  if (base === 'array') return `${solidityToTs(param.arrayChildren as ParamType)}[]`;
  if (base === 'tuple') {
    const comps = (param.components as readonly ParamType[]).map(
      (c, i) => `${keyOf(c.name || `_${i}`)}: ${solidityToTs(c)}`,
    );
    return `{ ${comps.join('; ')} }`;
  }
  if (/^u?int/.test(base)) return 'bigint';
  if (base === 'bool') return 'boolean';
  return 'string'; // address, bytes, bytesN, string
}

function params(list: readonly ParamType[]): ParamInfo[] {
  return list.map((p, i) => ({ name: p.name || `_${i}`, tsType: solidityToTs(p) }));
}

/** Sorts a group by key and suffixes every member when the name is shared. */
function disambiguate<T extends { name: string }>(items: T[], key: (t: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const g = groups.get(it.name) ?? [];
    g.push(it);
    groups.set(it.name, g);
  }
  const out: T[] = [];
  for (const g of groups.values()) {
    if (g.length === 1) {
      out.push(g[0]);
      continue;
    }
    g.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    g.forEach((it, i) => out.push({ ...it, name: `${it.name}_${i}` }));
  }
  return out;
}

/** Two emitted members with one name (e.g. overloads get -> get_0, get_1 next to a real get_0) cannot both exist. */
function assertUnique(contractName: string, kind: string, items: { name: string; signature: string }[]): void {
  const seen = new Map<string, string>();
  for (const it of items) {
    const other = seen.get(it.name);
    if (other !== undefined) {
      throw new Error(
        `${contractName}: two ${kind} would be named "${it.name}" (${other} and ${it.signature}); ` +
          'rename one of them in the ABI',
      );
    }
    seen.set(it.name, it.signature);
  }
}

function assertName(kind: string, name: string): void {
  if (!IDENT.test(name)) throw new Error(`Invalid ${kind} name "${name}": must match ${IDENT}`);
}

export function analyzeAbi(
  contractName: string,
  abi: unknown[],
): { functions: FnInfo[]; events: EventInfo[]; warnings: string[] } {
  assertName('contract', contractName);
  // ethers silently drops fragments it cannot parse (e.g. a name like "bad-name"), so check the raw entries.
  for (const raw of abi as Array<Record<string, unknown>>) {
    const emitted =
      (raw.type === 'function' && (raw.stateMutability === 'view' || raw.stateMutability === 'pure')) ||
      (raw.type === 'event' && raw.anonymous !== true);
    if (emitted) assertName(String(raw.type), String(raw.name));
  }
  const iface = new Interface(abi as never);
  const warnings: string[] = [];

  const fns: FnInfo[] = [];
  iface.forEachFunction((f) => {
    if (f.stateMutability !== 'view' && f.stateMutability !== 'pure') return;
    fns.push({
      name: f.name,
      signature: f.format('sighash'),
      selector: f.selector,
      inputs: params(f.inputs),
      outputs: params(f.outputs),
    });
  });

  const evs: EventInfo[] = [];
  iface.forEachEvent((e) => {
    if (e.anonymous) {
      warnings.push(`${contractName}: anonymous event ${e.name} skipped (it has no topic0 to filter on)`);
      return;
    }
    evs.push({ name: e.name, signature: e.format('sighash'), topic0: e.topicHash, inputs: params(e.inputs) });
  });

  const functions = disambiguate(fns, (f) => f.selector).map((f) => {
    assertName('function', f.name);
    return RESERVED.has(f.name) ? { ...f, name: `${f.name}_fn` } : f;
  });
  const events = disambiguate(evs, (e) => e.topic0);
  events.forEach((e) => assertName('event', e.name));
  assertUnique(contractName, 'functions', functions);
  assertUnique(contractName, 'events', events);
  return { functions, events, warnings };
}
