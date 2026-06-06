# Badminton Skedda

Typed Node.js client for fetching the Vision Badminton Skedda booking-list JSON.

The client first visits the Skedda venue page to collect
`X-Skedda-RequestVerificationCookie` and extract the hidden
`__RequestVerificationToken`, then requests `/bookingslists` with the cookie and
the `X-Skedda-RequestVerificationToken` header. By default, the range starts at
the beginning of today and ends at the end of the day two calendar months from
today.

## Install

```bash
npm install
npm run build
```

## Usage

```ts
import { fetchVisionBadmintonBookings } from "badminton-skedda";

type BookingListPayload = {
  bookings: Array<{
    id: string;
    title?: string;
    start?: string;
    end?: string;
  }>;
};

const response = await fetchVisionBadmintonBookings<BookingListPayload>();

response.data.bookings;
response.range.start;
response.range.end;
```

If Skedda changes the response shape or you do not know it yet, omit the generic
and `data` will be typed as `unknown`.

```ts
const response = await fetchVisionBadmintonBookings();
// response.data is unknown
```

You can override the range or pass a pre-existing cookie header:

```ts
const response = await fetchVisionBadmintonBookings({
  start: new Date("2026-06-05T00:00:00"),
  end: new Date("2026-08-05T23:59:59.999"),
  cookieHeader: "X-Skedda-RequestVerificationCookie=...",
  requestVerificationToken: "..."
});
```

## Generic Calendar Rows

Use `fetchVisionBadmintonCalendarRows` when you want Postgres-saveable rows for
locations, courts, import batches, and court bookings.

```ts
import { fetchVisionBadmintonCalendarRows } from "badminton-skedda";

const dataset = await fetchVisionBadmintonCalendarRows({
  start: "2026-06-05T00:00:00",
  end: "2026-06-05T23:59:59.999"
});

dataset.location;
dataset.courts;
dataset.import_batch;
dataset.bookings;
```

The mapper expands Skedda recurring bookings through `bookingslist.idx`, so each
`dataset.bookings` row represents one busy court interval on the requested date.
Rows are provider-neutral and include source IDs for upserts.

Hymus Sports is supported through the same model:

```ts
import { fetchHymusCalendarRows } from "badminton-skedda";

const dataset = await fetchHymusCalendarRows({
  start: "2026-06-06T00:00:00",
  end: "2026-06-06T23:59:59.999"
});
```

Hymus returns availability slots instead of bookings. The adapter gets a bearer
token from `/auth`, fetches `/bookings/:date/slots`, then inverts unavailable
courts into synthetic busy intervals.

The matching Postgres schema is in `sql/calendar_schema.sql`.

## Web Calendar

Run the local calendar webapp:

```bash
npm run dev
```

Open `http://localhost:3000`. The app loads one Monday-Sunday week at a time and
aggregates bookings into 30-minute availability slots. Slots before 10 AM are
blocked, Monday-Friday 9 AM-6 PM is blocked, green means at least 50% of courts
are available, and yellow means fewer than 50% are available. Use the location
selector to switch between Vision Badminton and Hymus Sports.
