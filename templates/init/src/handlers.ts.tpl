import { block } from 'evm-indexer';
// The Pool table and the Pool contract share a name, so codegen exports the entity as PoolEntity.
import { Account, PoolEntity } from '../generated';
import type { FactoryPoolCreatedEvent, PoolSwapEvent, TokenTransferEvent } from '../generated';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Loads an account or starts a fresh one; every field of a new entity must be set before save(). */
async function loadAccount(id: string): Promise<Account> {
  const existing = await Account.load(id);
  if (existing) return existing;
  const fresh = new Account(id);
  fresh.balance = 0n;
  return fresh;
}

// Shows entity load/save and the event context: block() is the block of the event being handled.
export async function handleTransfer(e: TokenTransferEvent): Promise<void> {
  const { from, to, value } = e.args;
  if (from !== ZERO_ADDRESS) {
    const sender = await loadAccount(from);
    sender.balance -= value;
    sender.updatedAt = block().timestamp;
    await sender.save();
  }
  if (to !== ZERO_ADDRESS) {
    const receiver = await loadAccount(to);
    receiver.balance += value;
    receiver.updatedAt = block().timestamp;
    await receiver.save();
  }
}

// Shows creating a new entity: the pool address from the event becomes the entity id.
export async function handlePoolCreated(e: FactoryPoolCreatedEvent): Promise<void> {
  const pool = new PoolEntity(e.args.pool);
  pool.token = e.args.token;
  pool.swapCount = 0;
  pool.createdAt = block().timestamp;
  await pool.save();
}

// Shows a template event: e.address is the pool that emitted the Swap.
export async function handleSwap(e: PoolSwapEvent): Promise<void> {
  const pool = await PoolEntity.load(e.address);
  if (!pool) throw new Error(`Pool ${e.address} was not created by the factory`);
  pool.swapCount += 1;
  await pool.save();
}
