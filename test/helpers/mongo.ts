import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';

let counter = 0;

/** Starts an in-memory MongoDB and hands out a database with a fresh name. */
export async function startMongo(): Promise<{ db: Db; stop(): Promise<void> }> {
  const server = await MongoMemoryServer.create();
  const client = await MongoClient.connect(server.getUri());
  counter += 1;
  const db = client.db(`test_${process.pid}_${Date.now()}_${counter}`);
  return {
    db,
    async stop() {
      await client.close();
      await server.stop();
    },
  };
}
