import { MongoClient, Db } from 'mongodb';

export async function connect(uri: string, dbName: string): Promise<{ client: MongoClient; db: Db }> {
  const client = await MongoClient.connect(uri);
  return { client, db: client.db(dbName) };
}
