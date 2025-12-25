"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = connectDB;
exports.getDB = getDB;
exports.getAccountsCollection = getAccountsCollection;
exports.getFoodCollection = getFoodCollection;
const mongodb_1 = require("mongodb");
require("dotenv/config");
if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI must be set in .env");
}
const client = new mongodb_1.MongoClient(process.env.MONGODB_URI);
let db;
/**
 * Connect once at app startup
 */
async function connectDB() {
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
function getDB() {
    if (!db) {
        throw new Error("❌ Database not initialized. Call connectDB() first.");
    }
    return db;
}
/**
 * Collection helpers
 */
function getAccountsCollection() {
    return getDB().collection("accounts");
}
function getFoodCollection() {
    return getDB().collection("food");
}
