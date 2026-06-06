import "dotenv/config";
import { runMigrations } from "../dist/db.js";

await runMigrations();
