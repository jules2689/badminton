import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pgConnectionString from "pg-connection-string";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type {
  CourtCalendarDataset,
  PostgresAppUserRow,
  PostgresBookingImportBatchRow,
  PostgresCourtBookingRow,
  PostgresCourtRow,
  PostgresLocationRow,
  PostgresUserAvailabilityWindowRow
} from "./models.js";

export interface ReadGroupAvailabilityInput {
  start: string;
  end: string;
}

export interface GroupAvailabilitySnapshot {
  users: PostgresAppUserRow[];
  windows: PostgresUserAvailabilityWindowRow[];
}

export interface CalendarDatabase {
  checkConnection(): Promise<void>;
  close(): Promise<void>;
  readLatestDataset(input: ReadLatestDatasetInput): Promise<CourtCalendarDataset | null>;
  readGroupAvailability(input: ReadGroupAvailabilityInput): Promise<GroupAvailabilitySnapshot>;
  readUserAvailability(
    input: ReadUserAvailabilityInput
  ): Promise<PostgresUserAvailabilityWindowRow[]>;
  saveDataset(dataset: CourtCalendarDataset): Promise<void>;
  replaceUserAvailability(input: ReplaceUserAvailabilityInput): Promise<void>;
  upsertUser(displayName: string): Promise<PostgresAppUserRow>;
}

export interface ReadLatestDatasetInput {
  source: string;
  locationId: string;
  start: string;
  end: string;
  maxAgeMs?: number;
}

export interface ReadUserAvailabilityInput {
  userId: string;
  start: string;
  end: string;
}

export interface ReplaceUserAvailabilityInput extends ReadUserAvailabilityInput {
  windows: PostgresUserAvailabilityWindowRow[];
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "sql",
  "migrations"
);

const schemaMigrationsSql = `
  create table if not exists schema_migrations (
    version text primary key,
    applied_at timestamptz not null default now()
  )
`;

export function getPostgresConnectionString(): string {
  const connectionString =
    process.env.DATABASE_URL?.trim() || process.env.POSTGRES_URL?.trim();

  if (!connectionString) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required.");
  }

  return connectionString;
}

function createPoolConfig(connectionString: string, max: number): PoolConfig {
  const parsed = pgConnectionString.parse(connectionString);
  const config = pgConnectionString.toClientConfig(parsed) as PoolConfig;
  config.max = max;

  if (process.env.PGSSLMODE?.trim().toLowerCase() === "disable") {
    config.ssl = false;
    return config;
  }

  const host = parsed.host ?? "";
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host.startsWith("/");

  if (isLocal) {
    config.ssl = false;
    return config;
  }

  config.ssl = {
    rejectUnauthorized: process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED?.trim() === "true"
  };

  return config;
}

export async function runMigrations(
  connectionString = getPostgresConnectionString()
): Promise<string[]> {
  const pool = new Pool(createPoolConfig(connectionString, 1));
  const applied: string[] = [];

  try {
    await pool.query(schemaMigrationsSql);

    const migrationFiles = (await readdir(migrationsDir))
      .filter((fileName) => fileName.endsWith(".sql"))
      .sort();
    const appliedResult = await pool.query<{ version: string }>(
      "select version from schema_migrations order by version"
    );
    const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));

    for (const fileName of migrationFiles) {
      if (appliedVersions.has(fileName)) {
        continue;
      }

      const sql = await readFile(join(migrationsDir, fileName), "utf8");
      const client = await pool.connect();

      try {
        await client.query("begin");
        await client.query(sql);
        await client.query("insert into schema_migrations (version) values ($1)", [fileName]);
        await client.query("commit");
        applied.push(fileName);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }

  return applied;
}

export function createCalendarDatabase(
  connectionString = getPostgresConnectionString()
): CalendarDatabase {
  const pool = new Pool(createPoolConfig(connectionString, 4));

  return new PostgresCalendarDatabase(pool);
}

class PostgresCalendarDatabase implements CalendarDatabase {
  constructor(private readonly pool: Pool) {}

  async checkConnection(): Promise<void> {
    await this.pool.query("select 1");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async readLatestDataset(input: ReadLatestDatasetInput): Promise<CourtCalendarDataset | null> {
    const client = await this.pool.connect();

    try {
      const batchResult = await client.query<PostgresBookingImportBatchRow>(
        `
          select
            id,
            source,
            location_id,
            range_start_at::text as range_start_at,
            range_end_at::text as range_end_at,
            request_url,
            fetched_at::text as fetched_at,
            raw_payload,
            metadata
          from booking_import_batches
          where source = $1
            and location_id = $2
            and range_start_at <= $3::timestamp
            and range_end_at >= $4::timestamp
            and ($5::bigint is null or fetched_at >= now() - ($5::bigint * interval '1 millisecond'))
          order by fetched_at desc
          limit 1
        `,
        [
          input.source,
          input.locationId,
          input.start,
          input.end,
          input.maxAgeMs ?? null
        ]
      );
      const importBatch = batchResult.rows[0];

      if (!importBatch) {
        return null;
      }

      const [locationResult, courtsResult, bookingsResult] = await Promise.all([
        client.query<PostgresLocationRow>(
          `
            select id, source, source_location_id, name, timezone, metadata
            from booking_locations
            where id = $1
          `,
          [input.locationId]
        ),
        client.query<PostgresCourtRow>(
          `
            select
              id,
              location_id,
              source,
              source_court_id,
              name,
              court_number,
              active,
              metadata
            from booking_courts
            where location_id = $1
              and active = true
            order by court_number nulls last, name
          `,
          [input.locationId]
        ),
        client.query<PostgresCourtBookingRow>(
          `
            select
              id,
              location_id,
              court_id,
              import_batch_id,
              source,
              source_booking_id,
              source_occurrence_id,
              starts_at::text as starts_at,
              ends_at::text as ends_at,
              timezone,
              status,
              title,
              raw_payload,
              metadata
            from court_bookings
            where location_id = $1
              and import_batch_id = $2
              and starts_at < $4::timestamp
              and ends_at > $3::timestamp
            order by starts_at, court_id
          `,
          [input.locationId, importBatch.id, input.start, input.end]
        )
      ]);
      const location = locationResult.rows[0];

      if (!location) {
        return null;
      }

      return {
        location,
        courts: courtsResult.rows,
        bookings: bookingsResult.rows,
        import_batch: importBatch
      };
    } finally {
      client.release();
    }
  }

  async readGroupAvailability(
    input: ReadGroupAvailabilityInput
  ): Promise<GroupAvailabilitySnapshot> {
    const [usersResult, windowsResult] = await Promise.all([
      this.pool.query<PostgresAppUserRow>(
        `
          select id, display_name
          from app_users
          order by display_name
        `
      ),
      this.pool.query<PostgresUserAvailabilityWindowRow>(
        `
          select
            id,
            user_id,
            to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') as starts_at,
            to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') as ends_at,
            status
          from user_availability_windows
          where starts_at < $2::timestamp
            and ends_at > $1::timestamp
          order by starts_at, user_id
        `,
        [input.start, input.end]
      )
    ]);

    return {
      users: usersResult.rows,
      windows: windowsResult.rows
    };
  }

  async readUserAvailability(
    input: ReadUserAvailabilityInput
  ): Promise<PostgresUserAvailabilityWindowRow[]> {
    const result = await this.pool.query<PostgresUserAvailabilityWindowRow>(
      `
        select
          id,
          user_id,
          to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') as starts_at,
          to_char(ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') as ends_at,
          status
        from user_availability_windows
        where user_id = $1
          and starts_at < $3::timestamp
          and ends_at > $2::timestamp
        order by starts_at
      `,
      [input.userId, input.start, input.end]
    );

    return result.rows;
  }

  async saveDataset(dataset: CourtCalendarDataset): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await upsertLocation(client, dataset.location);

      for (const court of dataset.courts) {
        await upsertCourt(client, court);
      }

      await upsertImportBatch(client, dataset.import_batch);

      for (const booking of dataset.bookings) {
        await upsertBooking(client, booking);
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async replaceUserAvailability(input: ReplaceUserAvailabilityInput): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("begin");
      await client.query(
        `
          delete from user_availability_windows
          where user_id = $1
            and starts_at < $3::timestamp
            and ends_at > $2::timestamp
        `,
        [input.userId, input.start, input.end]
      );

      for (const window of input.windows) {
        await upsertUserAvailabilityWindow(client, window);
      }

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertUser(displayName: string): Promise<PostgresAppUserRow> {
    const normalizedName = normalizeDisplayName(displayName);

    if (!normalizedName) {
      throw new Error("Display name is required.");
    }

    const row: PostgresAppUserRow = {
      id: makeUserId(normalizedName),
      display_name: normalizedName
    };
    const result = await this.pool.query<PostgresAppUserRow>(
      `
        insert into app_users (id, display_name)
        values ($1, $2)
        on conflict (id) do update set
          display_name = excluded.display_name,
          updated_at = now()
        returning id, display_name
      `,
      [row.id, row.display_name]
    );

    return result.rows[0] ?? row;
  }
}

async function upsertLocation(client: PoolClient, row: PostgresLocationRow): Promise<void> {
  await client.query(
    `
      insert into booking_locations (id, source, source_location_id, name, timezone, metadata)
      values ($1, $2, $3, $4, $5, $6)
      on conflict (id) do update set
        source = excluded.source,
        source_location_id = excluded.source_location_id,
        name = excluded.name,
        timezone = excluded.timezone,
        metadata = excluded.metadata,
        updated_at = now()
    `,
    [
      row.id,
      row.source,
      row.source_location_id,
      row.name,
      row.timezone,
      JSON.stringify(row.metadata)
    ]
  );
}

async function upsertCourt(client: PoolClient, row: PostgresCourtRow): Promise<void> {
  await client.query(
    `
      insert into booking_courts (
        id,
        location_id,
        source,
        source_court_id,
        name,
        court_number,
        active,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8)
      on conflict (id) do update set
        location_id = excluded.location_id,
        source = excluded.source,
        source_court_id = excluded.source_court_id,
        name = excluded.name,
        court_number = excluded.court_number,
        active = excluded.active,
        metadata = excluded.metadata,
        updated_at = now()
    `,
    [
      row.id,
      row.location_id,
      row.source,
      row.source_court_id,
      row.name,
      row.court_number,
      row.active,
      JSON.stringify(row.metadata)
    ]
  );
}

async function upsertImportBatch(
  client: PoolClient,
  row: PostgresBookingImportBatchRow
): Promise<void> {
  await client.query(
    `
      insert into booking_import_batches (
        id,
        source,
        location_id,
        range_start_at,
        range_end_at,
        request_url,
        fetched_at,
        raw_payload,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      on conflict (id) do update set
        source = excluded.source,
        location_id = excluded.location_id,
        range_start_at = excluded.range_start_at,
        range_end_at = excluded.range_end_at,
        request_url = excluded.request_url,
        fetched_at = excluded.fetched_at,
        raw_payload = excluded.raw_payload,
        metadata = excluded.metadata
    `,
    [
      row.id,
      row.source,
      row.location_id,
      row.range_start_at,
      row.range_end_at,
      row.request_url,
      row.fetched_at,
      JSON.stringify(row.raw_payload),
      JSON.stringify(row.metadata)
    ]
  );
}

async function upsertBooking(client: PoolClient, row: PostgresCourtBookingRow): Promise<void> {
  await client.query(
    `
      insert into court_bookings (
        id,
        location_id,
        court_id,
        import_batch_id,
        source,
        source_booking_id,
        source_occurrence_id,
        starts_at,
        ends_at,
        timezone,
        status,
        title,
        raw_payload,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      on conflict (id) do update set
        location_id = excluded.location_id,
        court_id = excluded.court_id,
        import_batch_id = excluded.import_batch_id,
        source = excluded.source,
        source_booking_id = excluded.source_booking_id,
        source_occurrence_id = excluded.source_occurrence_id,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        timezone = excluded.timezone,
        status = excluded.status,
        title = excluded.title,
        raw_payload = excluded.raw_payload,
        metadata = excluded.metadata,
        updated_at = now()
    `,
    [
      row.id,
      row.location_id,
      row.court_id,
      row.import_batch_id,
      row.source,
      row.source_booking_id,
      row.source_occurrence_id,
      row.starts_at,
      row.ends_at,
      row.timezone,
      row.status,
      row.title,
      JSON.stringify(row.raw_payload),
      JSON.stringify(row.metadata)
    ]
  );
}

async function upsertUserAvailabilityWindow(
  client: PoolClient,
  row: PostgresUserAvailabilityWindowRow
): Promise<void> {
  await client.query(
    `
      insert into user_availability_windows (
        id,
        user_id,
        starts_at,
        ends_at,
        status
      )
      values ($1, $2, $3, $4, $5)
      on conflict (id) do update set
        user_id = excluded.user_id,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        status = excluded.status,
        updated_at = now()
    `,
    [row.id, row.user_id, row.starts_at, row.ends_at, row.status]
  );
}

function normalizeDisplayName(value: string): string {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function makeUserId(displayName: string): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const digest = createHash("sha256").update(displayName).digest("hex").slice(0, 10);

  return `user:${slug || "name"}:${digest}`;
}
