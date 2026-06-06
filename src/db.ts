import { Pool, type PoolClient } from "pg";
import type {
  CourtCalendarDataset,
  PostgresBookingImportBatchRow,
  PostgresCourtBookingRow,
  PostgresCourtRow,
  PostgresLocationRow
} from "./models.js";

export interface CalendarDatabase {
  close(): Promise<void>;
  readLatestDataset(input: ReadLatestDatasetInput): Promise<CourtCalendarDataset | null>;
  saveDataset(dataset: CourtCalendarDataset): Promise<void>;
}

export interface ReadLatestDatasetInput {
  source: string;
  locationId: string;
  start: string;
  end: string;
  maxAgeMs?: number;
}

export function createCalendarDatabase(
  connectionString = process.env.DATABASE_URL
): CalendarDatabase | null {
  if (!connectionString) {
    return null;
  }

  const pool = new Pool({
    connectionString,
    max: 4
  });

  return new PostgresCalendarDatabase(pool);
}

class PostgresCalendarDatabase implements CalendarDatabase {
  constructor(private readonly pool: Pool) {}

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
