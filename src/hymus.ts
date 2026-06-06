import type {
  CourtCalendarDataset,
  JsonObject,
  JsonValue,
  PostgresBookingImportBatchRow,
  PostgresCourtBookingRow,
  PostgresCourtRow,
  PostgresLocationRow
} from "./models.js";

const DEFAULT_API_BASE_URL = "https://hymus-api-v2.onrender.com";
const DEFAULT_SOURCE = "hymus";
const DEFAULT_SOURCE_LOCATION_ID = "hymus-sports";
const DEFAULT_LOCATION_NAME = "Hymus Sports";
const DEFAULT_TIMEZONE = "America/Toronto";
const DEFAULT_TOTAL_COURTS = 14;
const SLOT_MINUTES = 30;
const SLOTS_PER_DAY = 48;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HymusSlot {
  slot: number;
  free: number;
  freeCourts: number[];
}

export interface HymusDaySlotsPayload {
  date: string;
  slots: HymusSlot[];
}

export interface FetchHymusOptions {
  apiBaseUrl?: string;
  fetch?: FetchLike;
  token?: string;
  totalCourts?: number;
}

export interface FetchHymusCalendarRowsOptions extends FetchHymusOptions {
  start?: Date | string;
  end?: Date | string;
  days?: number;
  source?: string;
  locationId?: string;
  sourceLocationId?: string;
  locationName?: string;
  timezone?: string | null;
  importBatchId?: string;
  fetchedAt?: Date | string;
  requestUrl?: string | null;
  locationMetadata?: JsonObject;
}

export class HymusRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body: string;

  constructor(response: Response, body: string) {
    super(`Hymus request failed with ${response.status} ${response.statusText}`);
    this.name = "HymusRequestError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.body = body;
  }
}

export async function fetchHymusAuthToken(
  options: FetchHymusOptions = {}
): Promise<string> {
  const fetchImpl = getFetch(options.fetch);
  const response = await fetchImpl(new URL("/auth", normalizeApiBaseUrl(options.apiBaseUrl)));
  const body = await response.text();

  if (!response.ok) {
    throw new HymusRequestError(response, body);
  }

  const parsed = JSON.parse(body) as unknown;

  if (typeof parsed !== "string" || !parsed) {
    throw new Error("Hymus auth response did not include a token string.");
  }

  return parsed;
}

export async function fetchHymusSlots(
  date: string,
  options: FetchHymusOptions = {}
): Promise<HymusDaySlotsPayload> {
  const fetchImpl = getFetch(options.fetch);
  const token = options.token ?? (await fetchHymusAuthToken(options));
  const url = new URL(`/bookings/${date}/slots`, normalizeApiBaseUrl(options.apiBaseUrl));
  const response = await fetchImpl(url, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`
    }
  });
  const body = await response.text();

  if (!response.ok) {
    throw new HymusRequestError(response, body);
  }

  return {
    date,
    slots: JSON.parse(body) as HymusSlot[]
  };
}

export async function fetchHymusCalendarRows(
  options: FetchHymusCalendarRowsOptions = {}
): Promise<CourtCalendarDataset> {
  const dates = createDateRange(options);
  const token = options.token ?? (await fetchHymusAuthToken(options));
  const days = await Promise.all(
    dates.map((date) =>
      fetchHymusSlots(date, {
        ...options,
        token
      })
    )
  );

  return mapHymusSlotsToPostgresRows(days, options);
}

export function mapHymusSlotsToPostgresRows(
  days: HymusDaySlotsPayload[],
  options: FetchHymusCalendarRowsOptions = {}
): CourtCalendarDataset {
  const totalCourts = options.totalCourts ?? DEFAULT_TOTAL_COURTS;
  const source = options.source ?? DEFAULT_SOURCE;
  const sourceLocationId = options.sourceLocationId ?? DEFAULT_SOURCE_LOCATION_ID;
  const locationId = options.locationId ?? makeStableId([source, sourceLocationId]);
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const sortedDays = [...days].sort((left, right) => left.date.localeCompare(right.date));
  const rangeStart = `${sortedDays[0]?.date ?? normalizeDate(options.start ?? new Date())}T00:00:00`;
  const rangeEnd = `${sortedDays.at(-1)?.date ?? normalizeDate(options.end ?? new Date())}T23:59:59.999`;
  const importBatchId =
    options.importBatchId ?? makeStableId([locationId, "import", rangeStart, rangeEnd]);
  const location: PostgresLocationRow = {
    id: locationId,
    source,
    source_location_id: sourceLocationId,
    name: options.locationName ?? DEFAULT_LOCATION_NAME,
    timezone,
    metadata: options.locationMetadata ?? {}
  };
  const courts = Array.from({ length: totalCourts }, (_, index) => {
    const courtNumber = index + 1;

    return {
      id: makeStableId([locationId, "court", courtNumber]),
      location_id: locationId,
      source,
      source_court_id: String(courtNumber),
      name: `Court ${courtNumber}`,
      court_number: courtNumber,
      active: true,
      metadata: {
        provider_court_number: courtNumber
      }
    } satisfies PostgresCourtRow;
  });
  const importBatch: PostgresBookingImportBatchRow = {
    id: importBatchId,
    source,
    location_id: locationId,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    request_url: options.requestUrl ?? null,
    fetched_at: toIsoString(options.fetchedAt ?? new Date()),
    raw_payload: toJsonValue({
      days: sortedDays,
      totalCourts
    }),
    metadata: {
      day_count: sortedDays.length,
      provider_payload: "slots"
    }
  };
  const bookings = sortedDays.flatMap((day) =>
    buildBusyIntervals(day, totalCourts).map<PostgresCourtBookingRow>((interval) => {
      const sourceOccurrenceId = makeStableId([
        day.date,
        interval.courtNumber,
        interval.startSlot,
        interval.endSlot
      ]);
      const courtId = makeStableId([locationId, "court", interval.courtNumber]);

      return {
        id: makeStableId([locationId, "booking", sourceOccurrenceId]),
        location_id: locationId,
        court_id: courtId,
        import_batch_id: importBatchId,
        source,
        source_booking_id: sourceOccurrenceId,
        source_occurrence_id: sourceOccurrenceId,
        starts_at: slotToTimestamp(day.date, interval.startSlot),
        ends_at: slotToTimestamp(day.date, interval.endSlot),
        timezone,
        status: "busy",
        title: null,
        raw_payload: toJsonValue({
          date: day.date,
          court: interval.courtNumber,
          startSlot: interval.startSlot,
          endSlot: interval.endSlot,
          source: "inverted_slots"
        }),
        metadata: {
          provider_court_number: interval.courtNumber,
          start_slot: interval.startSlot,
          end_slot: interval.endSlot
        }
      };
    })
  );

  return {
    location,
    courts,
    bookings,
    import_batch: importBatch
  };
}

interface BusyInterval {
  courtNumber: number;
  startSlot: number;
  endSlot: number;
}

function buildBusyIntervals(day: HymusDaySlotsPayload, totalCourts: number): BusyInterval[] {
  const slotsByIndex = new Map(day.slots.map((slot) => [slot.slot, slot]));
  const intervals: BusyInterval[] = [];

  for (let courtNumber = 1; courtNumber <= totalCourts; courtNumber += 1) {
    let busyStart: number | null = null;

    for (let slotIndex = 0; slotIndex <= SLOTS_PER_DAY; slotIndex += 1) {
      const slot = slotsByIndex.get(slotIndex);
      const isBusy =
        slotIndex < SLOTS_PER_DAY &&
        (!slot || !Array.isArray(slot.freeCourts) || !slot.freeCourts.includes(courtNumber));

      if (isBusy && busyStart === null) {
        busyStart = slotIndex;
      }

      if (!isBusy && busyStart !== null) {
        intervals.push({
          courtNumber,
          startSlot: busyStart,
          endSlot: slotIndex
        });
        busyStart = null;
      }
    }
  }

  return intervals;
}

function createDateRange(options: FetchHymusCalendarRowsOptions): string[] {
  const start = normalizeDate(options.start ?? new Date());
  const days =
    options.days ??
    (options.end ? daysBetween(start, normalizeDate(options.end)) + 1 : 1);

  return Array.from({ length: Math.max(1, days) }, (_, index) => addDays(start, index));
}

function normalizeApiBaseUrl(apiBaseUrl = DEFAULT_API_BASE_URL): URL {
  const url = new URL(apiBaseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function getFetch(fetchImpl?: FetchLike): FetchLike {
  const resolved = fetchImpl ?? globalThis.fetch;

  if (!resolved) {
    throw new Error("A fetch implementation is required. Use Node.js 20+ or pass options.fetch.");
  }

  return resolved;
}

function normalizeDate(value: Date | string): string {
  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0")
  ].join("-");
}

function slotToTimestamp(date: string, slot: number): string {
  const targetDate = addDays(date, Math.floor(slot / SLOTS_PER_DAY));
  const slotWithinDay = slot % SLOTS_PER_DAY;
  const minutes = slotWithinDay * SLOT_MINUTES;
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  return `${targetDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0"
  )}:00`;
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return normalizeDate(date);
}

function daysBetween(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const startMs = Date.UTC(startYear, startMonth - 1, startDay);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function makeStableId(parts: Array<string | number | null | undefined>): string {
  return parts
    .filter((part): part is string | number => part !== null && part !== undefined && part !== "")
    .map((part) =>
      String(part)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join(":");
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, next]) => next !== undefined && typeof next !== "function")
        .map(([key, next]) => [key, toJsonValue(next)])
    );
  }

  return null;
}
