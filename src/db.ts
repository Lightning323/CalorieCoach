import { MongoClient, Db, Collection } from "mongodb";
import "dotenv/config";

if (!process.env.MONGODB_URI) {
  throw new Error("MONGODB_URI must be set in .env");
}

const client = new MongoClient(process.env.MONGODB_URI);

let db: Db;

/**
 * Connect once at app startup
 */
export async function connectDB() {
  if (!db) {
    await client.connect();
    db = client.db("coach");
    console.log("✅ MongoDB connected to 'coach'");
  }
  return db;
}

/**
 * Get DB instance (after connectDB)
 */
export function getDB(): Db {
  if (!db) {
    throw new Error("❌ Database not initialized. Call connectDB() first.");
  }
  return db;
}

/**
 * Collection helpers
 */
export function getAccountsCollection(): Collection {
  return getDB().collection("accounts");
}

export function getFoodCollection(): Collection {
  return getDB().collection("food");
}
