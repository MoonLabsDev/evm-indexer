import type { BaseContract } from './contract';
import type { EventDef } from './events';
import { currentContext } from './context';
import type { ChainInput, AddressEntry } from '../types';

/** The static side of a generated contract class; `E` maps event names to event types. */
export interface ContractClass<E> {
  new (address: string): BaseContract;
  readonly abi: readonly unknown[];
  readonly events: Record<string, EventDef>;
  readonly eventTypes: E;
}

export type Callback<Ev> = (event: Ev) => void | Promise<void>;
/** `null` (index only), a process callback, or explicit index/process callbacks. */
export type EventEntry<Ev> = null | Callback<Ev> | { index?: Callback<Ev>; process?: Callback<Ev> };

export interface SourceDef<E> {
  contract: ContractClass<E>;
  events: { [K in keyof E]?: EventEntry<E[K]> };
}

export interface NormalizedSource {
  name: string;
  kind: 'contract' | 'template';
  contract: ContractClass<any>;
  events: Record<string, { index?: Callback<any>; process?: Callback<any> }>;
}

export interface NormalizedConfig<Names extends string = string> {
  sources: Record<string, NormalizedSource>;
  /** Type-only: the keys under `contracts`. Never set at runtime. */
  readonly __contracts?: Names;
}

export type TemplateSink = (template: string, address: string) => Promise<void>;

let sink: TemplateSink | null = null;

/** Installed by the indexer; receives addresses that index callbacks register. */
export function setTemplateSink(s: TemplateSink | null): void {
  sink = s;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class Template<E> {
  /** Set by `defineIndexer` to the template's key under `templates`. */
  name: string | null = null;

  constructor(readonly def: SourceDef<E>) {}

  /** Starts indexing this template at `address`; only allowed inside an index callback. */
  async create(address: string): Promise<void> {
    if (!sink || currentContext()?.mode !== 'index') {
      throw new Error('Template.create is only allowed in index callbacks');
    }
    if (this.name === null) throw new Error('template is not registered');
    if (!ADDRESS_RE.test(address)) throw new Error(`Template.create: invalid address ${address}`);
    await sink(this.name, address.toLowerCase());
  }
}

export function defineTemplate<E>(def: SourceDef<E>): Template<E> {
  return new Template(def);
}

function normalizeEntry(entry: EventEntry<unknown> | undefined): NormalizedSource['events'][string] {
  if (entry === null || entry === undefined) return {};
  if (typeof entry === 'function') return { process: entry };
  const out: NormalizedSource['events'][string] = {};
  if (entry.index) out.index = entry.index;
  if (entry.process) out.process = entry.process;
  return out;
}

function normalizeSource(name: string, kind: NormalizedSource['kind'], def: SourceDef<any>): NormalizedSource {
  const events: NormalizedSource['events'] = {};
  for (const [event, entry] of Object.entries(def.events as Record<string, EventEntry<unknown>>)) {
    if (!Object.prototype.hasOwnProperty.call(def.contract.events, event)) {
      throw new Error(`${kind} ${name}: unknown event ${event}`);
    }
    events[event] = normalizeEntry(entry);
  }
  return { name, kind, contract: def.contract, events };
}

export function defineIndexer<C, T>(cfg: {
  contracts: { [K in keyof C]: SourceDef<C[K]> };
  templates?: { [K in keyof T]: Template<T[K]> };
}): NormalizedConfig<keyof C & string> {
  const sources: Record<string, NormalizedSource> = {};
  for (const [name, def] of Object.entries(cfg.contracts as Record<string, SourceDef<any>>)) {
    sources[name] = normalizeSource(name, 'contract', def);
  }
  for (const [name, template] of Object.entries((cfg.templates ?? {}) as Record<string, Template<any>>)) {
    if (sources[name]) throw new Error(`name ${name} is used by both a contract and a template`);
    sources[name] = normalizeSource(name, 'template', template.def);
    template.name = name;
  }
  if (Object.values(sources).every((s) => Object.keys(s.events).length === 0)) {
    throw new Error('indexer config lists no events');
  }
  return { sources };
}

export type ConfigKind = 'chains' | 'schema' | 'addresses';

/**
 * A config value tagged for the loader. The tag is a plain string property so it
 * survives two module copies of the runtime (no instanceof, no module-local symbol).
 */
export interface Defined<K extends ConfigKind, V> {
  readonly __evmIndexerConfig: K;
  readonly value: V;
}

type BaseFieldType = 'string' | 'int' | 'float' | 'bigint' | 'decimal' | 'boolean' | 'address' | 'bytes' | 'timestamp';
export type SchemaFieldType<Tables extends string> =
  `${BaseFieldType | `ref:${Tables}`}${'' | '[]'}${'' | '?'}`;
export type SchemaInput<S> = { [T in keyof S]: Record<string, SchemaFieldType<keyof S & string>> };

function tag<K extends ConfigKind, V>(kind: K, value: V): Defined<K, V> {
  return { __evmIndexerConfig: kind, value };
}

export function defineChains(input: Record<number, ChainInput>): Defined<'chains', Record<number, ChainInput>> {
  return tag('chains', input);
}

export function defineSchema<const S extends SchemaInput<S>>(input: S): Defined<'schema', S> {
  return tag('schema', input);
}

/** Static addresses for the contracts of `config` (templates get theirs at runtime). */
export function defineAddresses<N extends string>(
  config: NormalizedConfig<N>,
  input: Record<number, { [K in N]: AddressEntry }>,
): Defined<'addresses', Record<number, Record<N, AddressEntry>>> {
  void config;
  return tag('addresses', input);
}
