import "dotenv/config";
import { runMigrations } from "../dist/db.js";

const applied = await runMigrations();

if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(", ")}`);
} else {
  console.log("Database schema is up to date.");
}
