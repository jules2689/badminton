export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface SkeddaBookingsRange {
  start: Date;
  end: Date;
  startParam: string;
  endParam: string;
}

export interface SkeddaBookingListsPayload {
  bookings?: unknown[];
  venueusers?: unknown;
  visits?: unknown[];
  bookingslist?: {
    bookings?: Array<string | number>;
    start?: string;
    end?: string;
    idx?: Record<string, Array<string | number>>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface PostgresLocationRow {
  id: string;
  source: string;
  source_location_id: string;
  name: string;
  timezone: string | null;
  metadata: JsonObject;
}

export interface PostgresCourtRow {
  id: string;
  location_id: string;
  source: string;
  source_court_id: string;
  name: string;
  court_number: number | null;
  active: boolean;
  metadata: JsonObject;
}

export type CourtBookingStatus = "busy" | "tentative" | "cancelled";

export interface PostgresCourtBookingRow {
  id: string;
  location_id: string;
  court_id: string;
  import_batch_id: string;
  source: string;
  source_booking_id: string;
  source_occurrence_id: string;
  starts_at: string;
  ends_at: string;
  timezone: string | null;
  status: CourtBookingStatus;
  title: string | null;
  raw_payload: JsonValue;
  metadata: JsonObject;
}

export interface PostgresBookingImportBatchRow {
  id: string;
  source: string;
  location_id: string;
  range_start_at: string;
  range_end_at: string;
  request_url: string | null;
  fetched_at: string;
  raw_payload: JsonValue;
  metadata: JsonObject;
}

export interface CourtCalendarDataset {
  location: PostgresLocationRow;
  courts: PostgresCourtRow[];
  bookings: PostgresCourtBookingRow[];
  import_batch: PostgresBookingImportBatchRow;
}

export interface PostgresAppUserRow {
  id: string;
  display_name: string;
}

export type UserAvailabilityStatus = "available" | "maybe" | "unavailable";

export interface PostgresUserAvailabilityWindowRow {
  id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
  status: UserAvailabilityStatus;
}

export interface MapSkeddaBookingsOptions {
  source?: string;
  locationId?: string;
  sourceLocationId?: string;
  locationName?: string;
  timezone?: string | null;
  courtLabels?: Record<string, string>;
  range?: SkeddaBookingsRange | { start: Date | string; end: Date | string };
  requestUrl?: string;
  importBatchId?: string;
  fetchedAt?: Date | string;
  locationMetadata?: JsonObject;
}

interface SkeddaBookingOccurrence {
  booking: Record<string, unknown>;
  sourceBookingId: string;
  occurrenceDate: string;
  startsAt: string;
  endsAt: string;
  spaces: string[];
}

const DEFAULT_SOURCE = "skedda";
const DEFAULT_SOURCE_LOCATION_ID = "visionbadminton";
const DEFAULT_LOCATION_NAME = "Vision Badminton Centre";
const DEFAULT_TIMEZONE = "America/Toronto";

export function mapSkeddaBookingsToPostgresRows(
  payload: SkeddaBookingListsPayload,
  options: MapSkeddaBookingsOptions = {}
): CourtCalendarDataset {
  const source = options.source ?? DEFAULT_SOURCE;
  const sourceLocationId = options.sourceLocationId ?? DEFAULT_SOURCE_LOCATION_ID;
  const locationId = options.locationId ?? makeStableId([source, sourceLocationId]);
  const timezone = options.timezone ?? DEFAULT_TIMEZONE;
  const location: PostgresLocationRow = {
    id: locationId,
    source,
    source_location_id: sourceLocationId,
    name: options.locationName ?? DEFAULT_LOCATION_NAME,
    timezone,
    metadata: options.locationMetadata ?? {}
  };

  const occurrences = buildSkeddaOccurrences(payload);
  const sourceCourtIds = Array.from(
    new Set(occurrences.flatMap((occurrence) => occurrence.spaces))
  ).sort(compareCourtIds);
  const courtNumberBySourceId = new Map(
    sourceCourtIds.map((sourceCourtId, index) => [sourceCourtId, index + 1])
  );
  const courtIdBySourceId = new Map(
    sourceCourtIds.map((sourceCourtId) => [
      sourceCourtId,
      makeStableId([locationId, "court", sourceCourtId])
    ])
  );
  const courts: PostgresCourtRow[] = sourceCourtIds.map((sourceCourtId) => {
    const courtNumber = courtNumberBySourceId.get(sourceCourtId) ?? null;

    return {
      id: courtIdBySourceId.get(sourceCourtId) ?? makeStableId([locationId, "court", sourceCourtId]),
      location_id: locationId,
      source,
      source_court_id: sourceCourtId,
      name: options.courtLabels?.[sourceCourtId] ?? defaultCourtName(sourceCourtId, courtNumber),
      court_number: courtNumber,
      active: true,
      metadata: {
        provider_space_id: sourceCourtId
      }
    };
  });

  const rangeStart = normalizeRangeStart(options.range, payload, occurrences);
  const rangeEnd = normalizeRangeEnd(options.range, payload, occurrences);
  const importBatchId =
    options.importBatchId ?? makeStableId([locationId, "import", rangeStart, rangeEnd]);
  const importBatch: PostgresBookingImportBatchRow = {
    id: importBatchId,
    source,
    location_id: locationId,
    range_start_at: rangeStart,
    range_end_at: rangeEnd,
    request_url: options.requestUrl ?? null,
    fetched_at: toIsoString(options.fetchedAt ?? new Date()),
    raw_payload: toJsonValue(payload),
    metadata: {
      occurrence_count: occurrences.length
    }
  };

  const bookings = occurrences.flatMap((occurrence) =>
    occurrence.spaces.map<PostgresCourtBookingRow>((sourceCourtId) => {
      const courtId =
        courtIdBySourceId.get(sourceCourtId) ?? makeStableId([locationId, "court", sourceCourtId]);
      const sourceOccurrenceId = makeStableId([
        occurrence.sourceBookingId,
        occurrence.occurrenceDate,
        sourceCourtId
      ]);

      return {
        id: makeStableId([locationId, "booking", sourceOccurrenceId]),
        location_id: locationId,
        court_id: courtId,
        import_batch_id: importBatchId,
        source,
        source_booking_id: occurrence.sourceBookingId,
        source_occurrence_id: sourceOccurrenceId,
        starts_at: occurrence.startsAt,
        ends_at: occurrence.endsAt,
        timezone,
        status: "busy",
        title: getBookingTitle(occurrence.booking),
        raw_payload: toJsonValue(occurrence.booking),
        metadata: {
          occurrence_date: occurrence.occurrenceDate,
          provider_space_id: sourceCourtId
        }
      };
    })
  );

  bookings.sort((left, right) => {
    const byStart = left.starts_at.localeCompare(right.starts_at);

    if (byStart !== 0) {
      return byStart;
    }

    return left.court_id.localeCompare(right.court_id);
  });

  return {
    location,
    courts,
    bookings,
    import_batch: importBatch
  };
}

function buildSkeddaOccurrences(payload: SkeddaBookingListsPayload): SkeddaBookingOccurrence[] {
  const bookings = getSkeddaBookings(payload);
  const bookingById = new Map(
    bookings.map((booking) => [getSourceBookingId(booking), booking] as const)
  );
  const idx = payload.bookingslist?.idx;

  if (idx && Object.keys(idx).length > 0) {
    return Object.entries(idx)
      .sort(([leftDate], [rightDate]) => leftDate.localeCompare(rightDate))
      .flatMap(([occurrenceDate, bookingIds]) =>
        bookingIds
          .map((bookingId) => bookingById.get(String(bookingId)))
          .filter(isRecord)
          .map((booking) => createOccurrence(booking, occurrenceDate))
          .filter(isPresent)
      );
  }

  return bookings
    .map((booking) => createOccurrence(booking, getDatePart(getString(booking.start))))
    .filter(isPresent);
}

function getSkeddaBookings(payload: SkeddaBookingListsPayload): Array<Record<string, unknown>> {
  return Array.isArray(payload.bookings) ? payload.bookings.filter(isRecord) : [];
}

function createOccurrence(
  booking: Record<string, unknown>,
  occurrenceDate: string | undefined
): SkeddaBookingOccurrence | null {
  const start = getString(booking.start);
  const end = getString(booking.end);

  if (!start || !end || !occurrenceDate) {
    return null;
  }

  const sourceBookingId = getSourceBookingId(booking);
  const timestamps = buildOccurrenceTimestamps(occurrenceDate, start, end);

  if (!sourceBookingId || !timestamps) {
    return null;
  }

  const spaces = getSpaces(booking);

  if (spaces.length === 0) {
    return null;
  }

  return {
    booking,
    sourceBookingId,
    occurrenceDate,
    startsAt: timestamps.startsAt,
    endsAt: timestamps.endsAt,
    spaces
  };
}

function buildOccurrenceTimestamps(
  occurrenceDate: string,
  originalStart: string,
  originalEnd: string
): { startsAt: string; endsAt: string } | null {
  const startParts = parseLocalDateTime(originalStart);
  const endParts = parseLocalDateTime(originalEnd);
  const dateParts = parseLocalDate(occurrenceDate);

  if (!startParts || !endParts || !dateParts) {
    return null;
  }

  const occurrenceStart = {
    ...startParts,
    year: dateParts.year,
    month: dateParts.month,
    day: dateParts.day
  };
  const durationMs = localDateTimeToUtcMs(endParts) - localDateTimeToUtcMs(startParts);
  const occurrenceEndMs = localDateTimeToUtcMs(occurrenceStart) + durationMs;

  return {
    startsAt: formatLocalDateTimeParts(occurrenceStart),
    endsAt: formatUtcMsAsLocalDateTime(occurrenceEndMs)
  };
}

function normalizeRangeStart(
  range: MapSkeddaBookingsOptions["range"],
  payload: SkeddaBookingListsPayload,
  occurrences: SkeddaBookingOccurrence[]
): string {
  if (range) {
    return normalizeDateTime(range.start);
  }

  if (payload.bookingslist?.start) {
    return payload.bookingslist.start;
  }

  return occurrences[0]?.startsAt ?? "";
}

function normalizeRangeEnd(
  range: MapSkeddaBookingsOptions["range"],
  payload: SkeddaBookingListsPayload,
  occurrences: SkeddaBookingOccurrence[]
): string {
  if (range) {
    return normalizeDateTime(range.end);
  }

  if (payload.bookingslist?.end) {
    return payload.bookingslist.end;
  }

  return occurrences.at(-1)?.endsAt ?? "";
}

function normalizeDateTime(value: Date | string): string {
  return value instanceof Date ? formatDate(value) : value;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function getSpaces(booking: Record<string, unknown>): string[] {
  return Array.isArray(booking.spaces)
    ? booking.spaces.map((space) => String(space)).filter(Boolean)
    : [];
}

function getSourceBookingId(booking: Record<string, unknown>): string {
  const id = booking.id;

  if (typeof id === "string" || typeof id === "number") {
    return String(id);
  }

  const occurrenceHash = booking.occurrenceHash;

  if (typeof occurrenceHash === "string" || typeof occurrenceHash === "number") {
    return String(occurrenceHash);
  }

  const start = getString(booking.start) ?? "unknown-start";
  const spaces = getSpaces(booking).join("-");
  return makeStableId(["unknown", start, spaces]);
}

function getBookingTitle(booking: Record<string, unknown>): string | null {
  const title = booking.title;

  if (typeof title === "string" && title.trim()) {
    return title.trim();
  }

  if (isRecord(title)) {
    for (const key of ["text", "title", "value", "plain"]) {
      const value = title[key];

      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }

  return null;
}

function defaultCourtName(sourceCourtId: string, courtNumber: number | null): string {
  if (/^\d+$/.test(sourceCourtId) && courtNumber) {
    return `Court ${courtNumber}`;
  }

  return sourceCourtId;
}

function compareCourtIds(left: string, right: string): number {
  const leftNumber = Number(left);
  const rightNumber = Number(right);

  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }

  return left.localeCompare(right, undefined, { numeric: true });
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

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getDatePart(value: string | undefined): string | undefined {
  return value?.slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
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

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, next]) => next !== undefined && typeof next !== "function")
        .map(([key, next]) => [key, toJsonValue(next)])
    );
  }

  return null;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
}

interface LocalDateTimeParts extends LocalDateParts {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

function parseLocalDate(value: string): LocalDateParts | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function parseLocalDateTime(value: string): LocalDateTimeParts | null {
  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/
  );

  if (!match) {
    return null;
  }

  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
    millisecond: Number((match[7] ?? "0").padEnd(3, "0"))
  };
}

function localDateTimeToUtcMs(parts: LocalDateTimeParts): number {
  return Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond
  );
}

function formatUtcMsAsLocalDateTime(value: number): string {
  const date = new Date(value);

  return formatLocalDateTimeParts({
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds()
  });
}

function formatLocalDateTimeParts(parts: LocalDateTimeParts): string {
  const base = `${parts.year}-${pad(parts.month, 2)}-${pad(parts.day, 2)}T${pad(
    parts.hour,
    2
  )}:${pad(parts.minute, 2)}:${pad(parts.second, 2)}`;

  if (parts.millisecond === 0) {
    return base;
  }

  return `${base}.${pad(parts.millisecond, 3)}`;
}

function formatDate(value: Date): string {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1, 2);
  const day = pad(value.getDate(), 2);
  const hour = pad(value.getHours(), 2);
  const minute = pad(value.getMinutes(), 2);
  const second = pad(value.getSeconds(), 2);
  const millisecond = pad(value.getMilliseconds(), 3);
  const base = `${year}-${month}-${day}T${hour}:${minute}:${second}`;

  if (value.getMilliseconds() === 0) {
    return base;
  }

  return `${base}.${millisecond}`;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}
