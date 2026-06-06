import {
  mapSkeddaBookingsToPostgresRows,
  type CourtCalendarDataset,
  type MapSkeddaBookingsOptions,
  type SkeddaBookingListsPayload,
  type SkeddaBookingsRange
} from "./models.js";

export * from "./models.js";
export * from "./hymus.js";
export * from "./db.js";

const DEFAULT_BASE_URL = "https://visionbadminton.skedda.com";
const DEFAULT_BOOTSTRAP_PATH = "/booking";
const BOOKINGS_LISTS_PATH = "/bookingslists";

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface FetchSkeddaBookingsOptions {
  /**
   * Venue base URL. Defaults to https://visionbadminton.skedda.com.
   */
  baseUrl?: string;

  /**
   * Path visited before /bookingslists to collect Skedda's verification cookie.
   */
  bootstrapPath?: string;

  /**
   * Range start. Defaults to the beginning of the current local day.
   */
  start?: Date | string;

  /**
   * Range end. Defaults to the end of the day two calendar months after now.
   */
  end?: Date | string;

  /**
   * Number of calendar months to include when end is omitted. Defaults to 2.
   */
  monthsAhead?: number;

  /**
   * Fixed current time for tests or deterministic callers.
   */
  now?: Date;

  /**
   * Existing Cookie header value. If provided, it is merged with cookies
   * collected during the bootstrap visit.
   */
  cookieHeader?: string;

  /**
   * Existing request-verification token. If omitted, the client extracts it
   * from the bootstrap page's hidden __RequestVerificationToken input.
   */
  requestVerificationToken?: string;

  /**
   * Extra headers applied to both requests.
   */
  headers?: HeadersInit;

  /**
   * Custom fetch implementation, useful for tests.
   */
  fetch?: FetchLike;
}

export interface FetchSkeddaBookingsResult<TData = unknown> {
  data: TData;
  range: SkeddaBookingsRange;
  requestUrl: string;
  status: number;
}

export interface FetchSkeddaCalendarRowsOptions
  extends FetchSkeddaBookingsOptions,
    Omit<MapSkeddaBookingsOptions, "range" | "requestUrl"> {}

export class SkeddaRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly body: string;

  constructor(response: Response, body: string) {
    super(`Skedda request failed with ${response.status} ${response.statusText}`);
    this.name = "SkeddaRequestError";
    this.status = response.status;
    this.statusText = response.statusText;
    this.url = response.url;
    this.body = body;
  }
}

export class SkeddaJsonParseError extends Error {
  readonly url: string;
  readonly body: string;

  constructor(url: string, body: string, cause: unknown) {
    super("Skedda response was not valid JSON", { cause });
    this.name = "SkeddaJsonParseError";
    this.url = url;
    this.body = body;
  }
}

export async function fetchVisionBadmintonBookings<TData = unknown>(
  options: FetchSkeddaBookingsOptions = {}
): Promise<FetchSkeddaBookingsResult<TData>> {
  return fetchSkeddaBookings<TData>({
    ...options,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL
  });
}

export async function fetchVisionBadmintonCalendarRows(
  options: FetchSkeddaCalendarRowsOptions = {}
): Promise<CourtCalendarDataset> {
  return fetchSkeddaCalendarRows({
    ...options,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL
  });
}

export async function fetchSkeddaBookings<TData = unknown>(
  options: FetchSkeddaBookingsOptions = {}
): Promise<FetchSkeddaBookingsResult<TData>> {
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error("A fetch implementation is required. Use Node.js 20+ or pass options.fetch.");
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const range = createRange(options);
  const jar = new CookieJar(options.cookieHeader);
  const headers = new Headers(options.headers);

  applyDefaultHeaders(headers, baseUrl);

  const bootstrapResult = await bootstrapCookies({
    baseUrl,
    bootstrapPath: options.bootstrapPath ?? DEFAULT_BOOTSTRAP_PATH,
    fetchImpl,
    headers,
    jar
  });
  const requestVerificationToken =
    options.requestVerificationToken ?? bootstrapResult.requestVerificationToken;

  const requestUrl = new URL(BOOKINGS_LISTS_PATH, baseUrl);
  requestUrl.searchParams.set("end", range.endParam);
  requestUrl.searchParams.set("start", range.startParam);
  const requestHeaders = headersWithCookies(headers, jar);

  if (requestVerificationToken && !requestHeaders.has("x-skedda-requestverificationtoken")) {
    requestHeaders.set("x-skedda-requestverificationtoken", requestVerificationToken);
  }

  const response = await fetchImpl(requestUrl, {
    headers: requestHeaders,
    redirect: "manual"
  });

  jar.addFromResponse(response);

  const body = await response.text();

  if (!response.ok) {
    throw new SkeddaRequestError(response, body);
  }

  try {
    return {
      data: JSON.parse(body) as TData,
      range,
      requestUrl: requestUrl.toString(),
      status: response.status
    };
  } catch (error) {
    throw new SkeddaJsonParseError(response.url || requestUrl.toString(), body, error);
  }
}

export async function fetchSkeddaCalendarRows(
  options: FetchSkeddaCalendarRowsOptions = {}
): Promise<CourtCalendarDataset> {
  const result = await fetchSkeddaBookings<SkeddaBookingListsPayload>(options);

  return mapSkeddaBookingsToPostgresRows(result.data, {
    ...options,
    range: result.range,
    requestUrl: result.requestUrl
  });
}

interface BootstrapCookiesInput {
  baseUrl: URL;
  bootstrapPath: string;
  fetchImpl: FetchLike;
  headers: Headers;
  jar: CookieJar;
}

interface BootstrapCookiesResult {
  requestVerificationToken?: string;
}

async function bootstrapCookies(input: BootstrapCookiesInput): Promise<BootstrapCookiesResult> {
  let url = new URL(input.bootstrapPath, input.baseUrl);

  for (let redirectCount = 0; redirectCount < 5; redirectCount += 1) {
    const response = await input.fetchImpl(url, {
      headers: headersWithCookies(input.headers, input.jar),
      redirect: "manual"
    });

    input.jar.addFromResponse(response);

    if (!isRedirect(response.status)) {
      const body = await response.text();
      const requestVerificationToken = parseRequestVerificationToken(body);
      return requestVerificationToken ? { requestVerificationToken } : {};
    }

    const location = response.headers.get("location");

    if (!location) {
      await response.arrayBuffer();
      return {};
    }

    await response.arrayBuffer();
    url = new URL(location, url);
  }

  throw new Error("Skedda cookie bootstrap exceeded the redirect limit.");
}

function createRange(options: FetchSkeddaBookingsOptions): SkeddaBookingsRange {
  const now = cloneDate(options.now ?? new Date());
  const start = options.start ? toDate(options.start) : startOfLocalDay(now);
  const end = options.end
    ? toDate(options.end)
    : endOfLocalDay(addCalendarMonths(now, options.monthsAhead ?? 2));

  if (Number.isNaN(start.getTime())) {
    throw new Error("Invalid Skedda start date.");
  }

  if (Number.isNaN(end.getTime())) {
    throw new Error("Invalid Skedda end date.");
  }

  if (end < start) {
    throw new Error("Skedda end date must be on or after the start date.");
  }

  return {
    start,
    end,
    startParam: formatSkeddaDate(start),
    endParam: formatSkeddaDate(end)
  };
}

function applyDefaultHeaders(headers: Headers, baseUrl: URL): void {
  if (!headers.has("accept")) {
    headers.set("accept", "application/json, text/plain, */*");
  }

  if (!headers.has("referer")) {
    headers.set("referer", new URL(DEFAULT_BOOTSTRAP_PATH, baseUrl).toString());
  }

  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    );
  }
}

function headersWithCookies(headers: Headers, jar: CookieJar): Headers {
  const next = new Headers(headers);
  const cookieHeader = jar.toHeader();

  if (cookieHeader) {
    next.set("cookie", cookieHeader);
  }

  return next;
}

class CookieJar {
  private readonly cookies = new Map<string, string>();

  constructor(cookieHeader?: string) {
    if (cookieHeader) {
      this.addCookieHeader(cookieHeader);
    }
  }

  addFromResponse(response: Response): void {
    for (const setCookie of getSetCookieHeaders(response.headers)) {
      const parsed = parseSetCookie(setCookie);

      if (parsed) {
        this.cookies.set(parsed.name, parsed.value);
      }
    }
  }

  toHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  private addCookieHeader(cookieHeader: string): void {
    for (const part of cookieHeader.split(";")) {
      const trimmed = part.trim();
      const equalsIndex = trimmed.indexOf("=");

      if (equalsIndex <= 0) {
        continue;
      }

      this.cookies.set(trimmed.slice(0, equalsIndex), trimmed.slice(equalsIndex + 1));
    }
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const maybeGetSetCookie = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };

  if (typeof maybeGetSetCookie.getSetCookie === "function") {
    return maybeGetSetCookie.getSetCookie();
  }

  if (typeof maybeGetSetCookie.raw === "function") {
    return maybeGetSetCookie.raw()["set-cookie"] ?? [];
  }

  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function parseSetCookie(setCookie: string): { name: string; value: string } | null {
  const firstPart = setCookie.split(";", 1)[0]?.trim();

  if (!firstPart) {
    return null;
  }

  const equalsIndex = firstPart.indexOf("=");

  if (equalsIndex <= 0) {
    return null;
  }

  return {
    name: firstPart.slice(0, equalsIndex),
    value: firstPart.slice(equalsIndex + 1)
  };
}

function parseRequestVerificationToken(html: string): string | undefined {
  const inputMatch = html.match(
    /<input\b(?=[^>]*\bname=["']__RequestVerificationToken["'])[^>]*>/i
  );
  const input = inputMatch?.[0];

  if (!input) {
    return undefined;
  }

  return input.match(/\bvalue=["']([^"']+)["']/i)?.[1];
}

function splitCombinedSetCookie(header: string): string[] {
  const cookies: string[] = [];
  let start = 0;
  let inExpires = false;

  for (let index = 0; index < header.length; index += 1) {
    const char = header[index];
    const previous = header.slice(Math.max(0, index - 8), index).toLowerCase();

    if (previous.endsWith("expires=")) {
      inExpires = true;
    }

    if (inExpires && char === ";") {
      inExpires = false;
    }

    if (!inExpires && char === ",") {
      const next = header.slice(index + 1);

      if (/^\s*[^=;,\s]+=/.test(next)) {
        cookies.push(header.slice(start, index).trim());
        start = index + 1;
      }
    }
  }

  cookies.push(header.slice(start).trim());
  return cookies.filter(Boolean);
}

function normalizeBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? cloneDate(value) : new Date(value);
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function startOfLocalDay(value: Date): Date {
  const date = cloneDate(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfLocalDay(value: Date): Date {
  const date = cloneDate(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

function addCalendarMonths(value: Date, months: number): Date {
  const date = cloneDate(value);
  const originalDay = date.getDate();

  date.setDate(1);
  date.setMonth(date.getMonth() + months);

  const lastDayOfTargetMonth = new Date(
    date.getFullYear(),
    date.getMonth() + 1,
    0
  ).getDate();

  date.setDate(Math.min(originalDay, lastDayOfTargetMonth));
  return date;
}

function formatSkeddaDate(value: Date): string {
  const year = value.getFullYear();
  const month = pad(value.getMonth() + 1, 2);
  const day = pad(value.getDate(), 2);
  const hour = pad(value.getHours(), 2);
  const minute = pad(value.getMinutes(), 2);
  const second = pad(value.getSeconds(), 2);
  const millisecond = pad(value.getMilliseconds(), 3);

  if (value.getMilliseconds() === 0) {
    return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  }

  return `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}`;
}

function pad(value: number, width: number): string {
  return value.toString().padStart(width, "0");
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}
