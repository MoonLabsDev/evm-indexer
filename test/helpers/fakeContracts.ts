import { BaseContract, type EventDef, type IndexedEvent } from '../../src/index';

// Hand-written stand-ins with the same statics a generated contract class has.

export interface FakeFactoryEvents {
  Created: IndexedEvent<{ pool: string }>;
  Paused: IndexedEvent<{}>;
  Owner: IndexedEvent<{ owner: string }>;
}

export class FakeFactory extends BaseContract {
  static readonly abi = [
    { type: 'event', name: 'Created', anonymous: false, inputs: [{ name: 'pool', type: 'address', indexed: false }] },
    { type: 'event', name: 'Paused', anonymous: false, inputs: [] },
    { type: 'event', name: 'Owner', anonymous: false, inputs: [{ name: 'owner', type: 'address', indexed: false }] },
  ] as const;
  static readonly events: Record<keyof FakeFactoryEvents, EventDef> = {
    Created: { name: 'Created', topic0: '0x01', signature: 'Created(address)' },
    Paused: { name: 'Paused', topic0: '0x02', signature: 'Paused()' },
    Owner: { name: 'Owner', topic0: '0x03', signature: 'Owner(address)' },
  };
  static readonly eventTypes = {} as FakeFactoryEvents;
  constructor(address: string) { super(address, FakeFactory.abi as unknown as unknown[]); }
}

export interface FakePoolEvents {
  Swap: IndexedEvent<{ amount: bigint }>;
}

export class FakePool extends BaseContract {
  static readonly abi = [
    { type: 'event', name: 'Swap', anonymous: false, inputs: [{ name: 'amount', type: 'uint256', indexed: false }] },
  ] as const;
  static readonly events: Record<keyof FakePoolEvents, EventDef> = {
    Swap: { name: 'Swap', topic0: '0x04', signature: 'Swap(uint256)' },
  };
  static readonly eventTypes = {} as FakePoolEvents;
  constructor(address: string) { super(address, FakePool.abi as unknown as unknown[]); }
}
