import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, Db } from 'mongodb';

let counter = 0;

/** Starts an in-memory MongoDB and hands out a database with a fresh name. */
export async function startMongo(): Promise<{ db: Db; uri: string; dbName: string; stop(): Promise<void> }> {
  const server = await MongoMemoryServer.create();
  const uri = server.getUri();
  const client = await MongoClient.connect(uri);
  counter += 1;
  const dbName = `test_${process.pid}_${Date.now()}_${counter}`;
  const db = client.db(dbName);
  return {
    db,
    uri,
    dbName,
    async stop() {
      await client.close();
      await server.stop();
    },
  };
}
