import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCalendarDatabase,
  fetchHymusCalendarRows,
  fetchVisionBadmintonCalendarRows
} from "../dist/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const cache = new Map();
const db = createCalendarDatabase();
const dbCacheMaxAgeMs = Number(process.env.CALENDAR_DB_CACHE_MAX_AGE_MS ?? 6 * 60 * 60 * 1000);
const locations = {
  visionbadminton: {
    id: "visionbadminton",
    label: "Vision Badminton Centre",
    source: "skedda",
    datasetLocationId: "skedda:visionbadminton",
    fetchRows: fetchVisionBadmintonCalendarRows
  },
  hymus: {
    id: "hymus",
    label: "Hymus Sports",
    source: "hymus",
    datasetLocationId: "hymus:hymus-sports",
    fetchRows: fetchHymusCalendarRows
  }
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/bookings") {
      await handleBookingsApi(url, response);
      return;
    }

    if (url.pathname === "/api/locations") {
      sendJson(response, 200, Object.values(locations).map(({ id, label }) => ({ id, label })));
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      sendJson(response, 404, {
        error: "not_found"
      });
      return;
    }

    console.error(error);
    sendJson(response, 500, {
      error: "internal_server_error",
      message: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(port, host, () => {
  console.log(`Badminton calendar running at http://${host}:${port}`);
});

async function handleBookingsApi(url, response) {
  const startDate = normalizeDateParam(
    url.searchParams.get("start") ?? url.searchParams.get("date")
  );
  const days = clamp(Number(url.searchParams.get("days") ?? 7), 1, 14);
  const locationId = url.searchParams.get("location") ?? "all";
  const selectedLocations =
    locationId === "all" ? Object.values(locations) : [locations[locationId]].filter(Boolean);

  if (selectedLocations.length === 0) {
    sendJson(response, 400, {
      error: "unknown_location",
      locations: ["all", ...Object.keys(locations)]
    });
    return;
  }

  const endDate = addDaysToDateString(startDate, days - 1);
  const todayDate = todayDateString();
  const fetchStartDate = maxDateString(startDate, todayDate);
  const fetchDays = fetchStartDate <= endDate ? daysBetween(fetchStartDate, endDate) + 1 : 0;
  const cacheKey = `${locationId}:${startDate}:${days}:today:${todayDate}`;
  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < 60_000) {
    sendJson(response, 200, cached.payload);
    return;
  }

  const datasets =
    fetchDays > 0
      ? await Promise.all(
          selectedLocations.map((location) =>
            loadLocationDataset(location, fetchStartDate, endDate, fetchDays)
          )
        )
      : [];
  const payload = toCalendarPayload(datasets, fetchStartDate, fetchDays);

  cache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
  sendJson(response, 200, payload);
}

function toCalendarPayload(datasets, startDate, days) {
  const dates =
    days > 0
      ? Array.from({ length: days }, (_, index) => addDaysToDateString(startDate, index))
      : [];

  return {
    date: startDate,
    dates,
    availableLocations: Object.values(locations).map(({ id, label }) => ({ id, label })),
    locations: datasets.map(({ locationId, dataset, error }) => ({
      id: locationId,
      label: locations[locationId]?.label ?? dataset?.location.name ?? locationId,
      error: error ?? null,
      location: dataset?.location ?? null,
      range: {
        start: dataset?.import_batch.range_start_at ?? startDate,
        end: dataset?.import_batch.range_end_at ?? addDaysToDateString(startDate, days - 1),
        fetched_at: dataset?.import_batch.fetched_at ?? new Date().toISOString()
      },
      courts: (dataset?.courts ?? []).map((court) => ({
        id: court.id,
        source_court_id: court.source_court_id,
        name: court.name,
        court_number: court.court_number,
        active: court.active
      })),
      bookings: (dataset?.bookings ?? []).map((booking) => ({
        id: booking.id,
        court_id: booking.court_id,
        starts_at: booking.starts_at,
        ends_at: booking.ends_at,
        status: booking.status
      }))
    }))
  };
}

async function loadLocationDataset(location, startDate, endDate, days) {
  const rangeStart = `${startDate}T00:00:00`;
  const rangeEnd = `${endDate}T23:59:59.999`;
  const cachedDataset = db
    ? await db.readLatestDataset({
        source: location.source,
        locationId: location.datasetLocationId,
        start: rangeStart,
        end: rangeEnd,
        maxAgeMs: dbCacheMaxAgeMs
      })
    : null;

  if (cachedDataset) {
    return {
      locationId: location.id,
      dataset: cachedDataset
    };
  }

  try {
    const dataset = await location.fetchRows({
      start: rangeStart,
      end: rangeEnd,
      days
    });

    if (db) {
      await db.saveDataset(dataset);
    }

    return {
      locationId: location.id,
      dataset
    };
  } catch (error) {
    console.error(error);

    const staleDataset = db
      ? await db.readLatestDataset({
          source: location.source,
          locationId: location.datasetLocationId,
          start: rangeStart,
          end: rangeEnd
        })
      : null;

    if (staleDataset) {
      return {
        locationId: location.id,
        dataset: staleDataset,
        error: "using_stale_cache"
      };
    }

    return {
      locationId: location.id,
      dataset: null,
      error: error instanceof Error ? error.message : "provider_unavailable"
    };
  }
}

async function serveStatic(pathname, response) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, safePath);
  const body = await readFile(filePath);
  const contentType = getContentType(filePath);

  response.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-cache"
  });
  response.end(body);
}

function normalizeDateParam(value) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToDateString(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function todayDateString() {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("-");
}

function maxDateString(left, right) {
  return left >= right ? left : right;
}

function daysBetween(start, end) {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const startMs = Date.UTC(startYear, startMonth - 1, startDay);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, value));
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  response.end(JSON.stringify(payload));
}

function getContentType(filePath) {
  switch (extname(filePath)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml; charset=utf-8";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}
