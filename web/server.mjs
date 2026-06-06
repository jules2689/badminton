import "dotenv/config";
import { createServer } from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCalendarDatabase,
  getPostgresConnectionString,
  runMigrations,
  fetchHymusCalendarRows,
  fetchVisionBadmintonCalendarRows
} from "../dist/index.js";

function requireEnv(name) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const cache = new Map();
const databaseUrl = getPostgresConnectionString();
const basicAuthPassword = requireEnv("BASIC_AUTH_PASSWORD");
const basicAuthRealm = process.env.BASIC_AUTH_REALM ?? "Badminton Calendar";
const db = createCalendarDatabase(databaseUrl);
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
    const authUser = authenticateRequest(request, response);

    if (!authUser) {
      return;
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

    if (url.pathname === "/api/bookings") {
      await handleBookingsApi(url, response);
      return;
    }

    if (url.pathname === "/api/locations") {
      sendJson(response, 200, Object.values(locations).map(({ id, label }) => ({ id, label })));
      return;
    }

    if (url.pathname === "/logout" || url.pathname === "/api/logout") {
      sendBasicAuthChallenge(response, "Logged out");
      return;
    }

    if (url.pathname === "/api/me") {
      await handleMeApi(authUser, response);
      return;
    }

    if (url.pathname === "/api/availability/group" && request.method === "GET") {
      await handleReadGroupAvailabilityApi(url, response);
      return;
    }

    if (url.pathname === "/api/availability" && request.method === "GET") {
      await handleReadAvailabilityApi(authUser, url, response);
      return;
    }

    if (url.pathname === "/api/availability" && request.method === "PUT") {
      await handleSaveAvailabilityApi(authUser, request, response);
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

async function startServer() {
  await db.checkConnection();
  console.log("Database connection verified");

  const appliedMigrations = await runMigrations(databaseUrl);

  if (appliedMigrations.length > 0) {
    console.log(`Applied migrations: ${appliedMigrations.join(", ")}`);
  }

  server.listen(port, host, () => {
    console.log(`Badminton calendar running at http://${host}:${port}`);
  });
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function handleBookingsApi(url, response) {
  const startDate = normalizeDateParam(url.searchParams.get("start"));
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
  const payload = toCalendarPayload(datasets, startDate, days);

  cache.set(cacheKey, {
    createdAt: Date.now(),
    payload
  });
  sendJson(response, 200, payload);
}

async function handleMeApi(authUser, response) {
  const user = await db.upsertUser(authUser.displayName);

  sendJson(response, 200, { user });
}

async function handleReadGroupAvailabilityApi(url, response) {
  const startDate = maxDateString(
    normalizeDateParam(url.searchParams.get("start")),
    todayDateString()
  );
  const days = clamp(Number(url.searchParams.get("days") ?? 7), 1, 14);
  const endDate = addDaysToDateString(startDate, days - 1);
  const snapshot = await db.readGroupAvailability({
    start: `${startDate}T00:00:00`,
    end: `${endDate}T23:59:59.999`
  });

  sendJson(response, 200, snapshot);
}

async function handleReadAvailabilityApi(authUser, url, response) {
  const user = await db.upsertUser(authUser.displayName);
  const startDate = maxDateString(
    normalizeDateParam(url.searchParams.get("start")),
    todayDateString()
  );
  const days = clamp(Number(url.searchParams.get("days") ?? 7), 1, 14);
  const endDate = addDaysToDateString(startDate, days - 1);
  const windows = await db.readUserAvailability({
    userId: user.id,
    start: `${startDate}T00:00:00`,
    end: `${endDate}T23:59:59.999`
  });

  sendJson(response, 200, {
    user,
    windows
  });
}

async function handleSaveAvailabilityApi(authUser, request, response) {
  const body = await readJsonBody(request);
  const user = await db.upsertUser(authUser.displayName);
  const startDate = maxDateString(
    normalizeDateParam(typeof body.start === "string" ? body.start : undefined),
    todayDateString()
  );
  const days = clamp(Number(body.days ?? 7), 1, 14);
  const endDate = addDaysToDateString(startDate, days - 1);
  const rangeStart = `${startDate}T00:00:00`;
  const rangeEnd = `${endDate}T23:59:59.999`;

  const windows = Array.isArray(body.windows)
    ? body.windows
        .map((window) => normalizeAvailabilityWindow(user.id, window))
        .filter(Boolean)
        .filter((window) => window.starts_at >= rangeStart && window.starts_at <= `${endDate}T23:59:59.999`)
    : [];

  await db.replaceUserAvailability({
    userId: user.id,
    start: rangeStart,
    end: rangeEnd,
    windows
  });

  sendJson(response, 200, {
    user,
    windows
  });
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
  const cachedDataset = await readLatestDatasetSafely(location, rangeStart, rangeEnd, {
    maxAgeMs: dbCacheMaxAgeMs
  });

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

    await db.saveDataset(dataset);

    return {
      locationId: location.id,
      dataset
    };
  } catch (error) {
    console.error(error);

    const staleDataset = await readLatestDatasetSafely(location, rangeStart, rangeEnd);

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

async function readLatestDatasetSafely(location, rangeStart, rangeEnd, options = {}) {
  try {
    return await db.readLatestDataset({
      source: location.source,
      locationId: location.datasetLocationId,
      start: rangeStart,
      end: rangeEnd,
      maxAgeMs: options.maxAgeMs
    });
  } catch (error) {
    console.error(error);
    return null;
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

function authenticateRequest(request, response) {
  const header = request.headers.authorization ?? "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    sendBasicAuthChallenge(response);
    return null;
  }

  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");

  if (separatorIndex < 0) {
    sendBasicAuthChallenge(response);
    return null;
  }

  const displayName = normalizeDisplayName(decoded.slice(0, separatorIndex));
  const password = decoded.slice(separatorIndex + 1);

  if (!displayName || !constantTimeEqual(password, basicAuthPassword)) {
    sendBasicAuthChallenge(response);
    return null;
  }

  return {
    displayName
  };
}

function sendBasicAuthChallenge(response, message = "Authentication required") {
  response.writeHead(401, {
    "www-authenticate": `Basic realm="${basicAuthRealm.replace(/"/g, "")}", charset="UTF-8"`,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-cache"
  });
  response.end(message);
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function normalizeAvailabilityWindow(userId, value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const startsAt = typeof value.starts_at === "string" ? value.starts_at : "";
  const endsAt = typeof value.ends_at === "string" ? value.ends_at : "";
  const status = typeof value.status === "string" ? value.status : "available";

  if (!isLocalDateTime(startsAt) || !isLocalDateTime(endsAt)) {
    return null;
  }

  if (!["available", "maybe", "unavailable"].includes(status)) {
    return null;
  }

  if (endsAt <= startsAt) {
    return null;
  }

  return {
    id:
      typeof value.id === "string" && value.id
        ? value.id
        : `availability:${makeStableId([userId, startsAt, endsAt]) || randomUUID()}`,
    user_id: userId,
    starts_at: startsAt,
    ends_at: endsAt,
    status
  };
}

function isLocalDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value);
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

function normalizeDisplayName(value) {
  return value.trim().replace(/\s+/g, " ").slice(0, 80);
}

function constantTimeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();

  return timingSafeEqual(leftDigest, rightDigest);
}

function makeStableId(parts) {
  return parts
    .filter((part) => part !== null && part !== undefined && part !== "")
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
