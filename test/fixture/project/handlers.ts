import { block, tx } from '../../../src/index';
import { Factory, PoolEntity, Stats, type FactoryPoolCreatedEvent, type PoolPingEvent } from './generated';

/** Every `poolCount()` value handlePoolCreated read, in call order (lets the test see the call block). */
export const poolCountReads: number[] = [];

export async function handlePoolCreated(e: FactoryPoolCreatedEvent): Promise<void> {
  const pool = new PoolEntity(e.args.pool);
  pool.createdAt = block().timestamp;
  pool.creator = tx().from;
  pool.pings = 0;
  pool.lastPing = 0n;
  await pool.save();

  const count = Number(await new Factory(e.address).poolCount());
  poolCountReads.push(count);
  const stats = (await Stats.load('global')) ?? new Stats('global');
  stats.poolCount = count;
  await stats.save();
}

export async function handlePing(e: PoolPingEvent): Promise<void> {
  const pool = await PoolEntity.load(e.address);
  if (!pool) throw new Error(`PoolEntity ${e.address} does not exist`);
  pool.pings += 1;
  pool.lastPing = e.args.n;
  await pool.save();
}
