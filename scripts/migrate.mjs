import "dotenv/config";
import { runMigrations } from "../dist/db.js";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const applied = await runMigrations();

if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(", ")}`);
} else {
  console.log("Database schema is up to date.");
}
