create table if not exists booking_locations (
  id text primary key,
  source text not null,
  source_location_id text not null,
  name text not null,
  timezone text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source, source_location_id)
);

create table if not exists booking_courts (
  id text primary key,
  location_id text not null references booking_locations(id) on delete cascade,
  source text not null,
  source_court_id text not null,
  name text not null,
  court_number integer,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, source, source_court_id)
);

create table if not exists booking_import_batches (
  id text primary key,
  source text not null,
  location_id text not null references booking_locations(id) on delete cascade,
  range_start_at timestamp without time zone not null,
  range_end_at timestamp without time zone not null,
  request_url text,
  fetched_at timestamptz not null,
  raw_payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (range_end_at >= range_start_at)
);

create table if not exists court_bookings (
  id text primary key,
  location_id text not null references booking_locations(id) on delete cascade,
  court_id text not null references booking_courts(id) on delete cascade,
  import_batch_id text not null references booking_import_batches(id) on delete cascade,
  source text not null,
  source_booking_id text not null,
  source_occurrence_id text not null,
  starts_at timestamp without time zone not null,
  ends_at timestamp without time zone not null,
  timezone text,
  status text not null default 'busy',
  title text,
  raw_payload jsonb not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (status in ('busy', 'tentative', 'cancelled')),
  unique (location_id, source, source_occurrence_id, court_id)
);

create index if not exists booking_courts_location_idx
  on booking_courts (location_id, active, court_number, name);

create index if not exists court_bookings_location_time_idx
  on court_bookings (location_id, starts_at, ends_at);

create index if not exists court_bookings_court_time_idx
  on court_bookings (court_id, starts_at, ends_at);

create table if not exists app_users (
  id text primary key,
  display_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_availability_windows (
  id text primary key,
  user_id text not null references app_users(id) on delete cascade,
  starts_at timestamp without time zone not null,
  ends_at timestamp without time zone not null,
  status text not null default 'available',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (status in ('available', 'maybe', 'unavailable'))
);

create index if not exists user_availability_windows_user_time_idx
  on user_availability_windows (user_id, starts_at, ends_at);
