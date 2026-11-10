import type { NormalizedSource } from '../runtime/define';
import type { EventDef } from '../runtime/events';
import type { RawLog, StaticEntry } from '../types';

export interface Match { source: NormalizedSource; eventName: string; def: EventDef }

export class RegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryError';
  }
}

interface Entry {
  source: NormalizedSource;
  block: number;
  /** topic0 (lowercase) → event, for the configured events only. */
  events: Map<string, { eventName: string; def: EventDef }>;
}

/** In-memory map of which address belongs to which configured source, and from which block. */
export class Registry {
  private readonly entries = new Map<string, Entry>();
  private readonly eventsBySource = new Map<string, Entry['events']>();

  constructor(private readonly sources: Record<string, NormalizedSource>) {}

  /** Registers static addresses; an address owned by another source is an error. */
  addStatic(entries: StaticEntry[]): void {
    for (const e of entries) {
      const address = e.address.toLowerCase();
      const source = this.source(e.source);
      const existing = this.entries.get(address);
      if (!existing) {
        this.entries.set(address, { source, block: e.block, events: this.eventsOf(source) });
      } else if (existing.source.name !== source.name) {
        throw new RegistryError(`address ${address} belongs to ${existing.source.name}, cannot add it to ${source.name}`);
      } else if (e.block < existing.block) {
        existing.block = e.block;
      }
    }
  }

  /** Registers a dynamic address; an already registered address keeps its block. */
  add(sourceName: string, address: string, block: number): 'added' | 'exists' | 'conflict' {
    const source = this.source(sourceName);
    const key = address.toLowerCase();
    const existing = this.entries.get(key);
    if (existing) return existing.source.name === source.name ? 'exists' : 'conflict';
    this.entries.set(key, { source, block, events: this.eventsOf(source) });
    return 'added';
  }

  match(log: RawLog): Match | null {
    const entry = this.entries.get(log.address.toLowerCase());
    if (!entry || log.blockNumber < entry.block || log.topics.length === 0) return null;
    const hit = entry.events.get(log.topics[0].toLowerCase());
    return hit ? { source: entry.source, eventName: hit.eventName, def: hit.def } : null;
  }

  addresses(): string[] {
    return [...this.entries.keys()];
  }

  /** topic0 values of all configured events of all registered addresses, without duplicates. */
  topics(): string[] {
    const out = new Set<string>();
    for (const entry of this.entries.values()) for (const t of entry.events.keys()) out.add(t);
    return [...out];
  }

  topicsOf(address: string): string[] {
    const entry = this.entries.get(address.toLowerCase());
    return entry ? [...entry.events.keys()] : [];
  }

  minBlock(): number | null {
    let min: number | null = null;
    for (const entry of this.entries.values()) if (min === null || entry.block < min) min = entry.block;
    return min;
  }

  size(): number {
    return this.entries.size;
  }

  private source(name: string): NormalizedSource {
    const source = Object.prototype.hasOwnProperty.call(this.sources, name) ? this.sources[name] : undefined;
    if (!source) throw new RegistryError(`unknown source ${name}`);
    return source;
  }

  private eventsOf(source: NormalizedSource): Entry['events'] {
    let events = this.eventsBySource.get(source.name);
    if (!events) {
      events = new Map();
      for (const eventName of Object.keys(source.events)) {
        const def = source.contract.events[eventName];
        events.set(def.topic0.toLowerCase(), { eventName, def });
      }
      this.eventsBySource.set(source.name, events);
    }
    return events;
  }
}
