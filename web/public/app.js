const SLOT_MINUTES = 30;
const SLOT_HEIGHT = 52;
const START_HOUR = 6;
const END_HOUR = 24;
const MORNING_BLOCK_END_MINUTE = 10 * 60;
const BUSINESS_START_MINUTE = 9 * 60;
const BUSINESS_END_MINUTE = 18 * 60;

const elements = {
  calendar: document.querySelector("#calendar"),
  status: document.querySelector("#status"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  dateInput: document.querySelector("#dateInput"),
  previousWeek: document.querySelector("#previousWeek"),
  nextWeek: document.querySelector("#nextWeek"),
  refreshButton: document.querySelector("#refreshButton"),
  courtCount: document.querySelector("#courtCount"),
  openSlotCount: document.querySelector("#openSlotCount"),
  fetchedAt: document.querySelector("#fetchedAt")
};

elements.dateInput.min = todayDateString();
elements.dateInput.value = todayDateString();
elements.previousWeek.addEventListener("click", () => shiftWeek(-1));
elements.nextWeek.addEventListener("click", () => shiftWeek(1));
elements.refreshButton.addEventListener("click", () => loadWeek());
elements.dateInput.addEventListener("change", () => {
  elements.dateInput.value = maxDateString(elements.dateInput.value, todayDateString());
  loadWeek();
});

loadWeek();

async function loadWeek() {
  setStatus("Loading availability");
  setLoading(true);

  try {
    const start = elements.dateInput.value;
    const response = await fetch(`/api/bookings?start=${encodeURIComponent(start)}&days=7`);

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const payload = await response.json();
    renderWeek(payload);
    setStatus(formatWeekRange(payload.dates));
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Unable to load availability", "error");
    elements.calendar.replaceChildren();
  } finally {
    setLoading(false);
  }
}

function renderWeek(payload) {
  const dates = (payload.dates ?? []).filter((date) => date >= todayDateString());
  const locations = payload.locations ?? [];
  const courtCount = locations.reduce((total, location) => total + location.courts.length, 0);
  const slots = buildSlots(dates);
  const bookingsByLocationAndDate = new Map(
    locations.map((location) => [
      location.id,
      new Map(
        dates.map((date) => [
          date,
          location.bookings.filter((booking) => overlapsDate(booking, date))
        ])
      )
    ])
  );
  let openSlotCount = 0;

  elements.courtCount.textContent = String(courtCount);
  elements.fetchedAt.textContent = formatFetchedAt(
    newestFetchedAt(locations.map((location) => location.range.fetched_at))
  );
  elements.calendar.style.setProperty("--day-count", String(dates.length));
  elements.calendar.style.setProperty("--slot-height", `${SLOT_HEIGHT}px`);

  if (dates.length === 0) {
    elements.openSlotCount.textContent = "0";
    elements.calendar.replaceChildren(createNode("div", "empty-state", "No upcoming dates in this range."));
    return;
  }

  const heading = createNode("div", "week-headings");
  heading.append(createNode("div", "time-corner"));

  for (const date of dates) {
    const dayHeading = createNode("div", "day-heading");
    dayHeading.append(createNode("strong", "", formatWeekday(date)));
    dayHeading.append(createNode("span", "", formatShortDate(date)));
    heading.append(dayHeading);
  }

  const grid = createNode("div", "availability-grid");

  for (const slot of slots) {
    const timeCell = createNode("div", slot.minute === 0 ? "time-cell major" : "time-cell");
    timeCell.textContent = slot.minute === 0 ? formatHour(slot.hour) : "";
    grid.append(timeCell);

    for (const date of dates) {
      const cell = createAvailabilityCell({
        date,
        slot,
        locations,
        bookingsByLocationAndDate
      });

      openSlotCount += Number(cell.dataset.openCount ?? 0);

      grid.append(cell);
    }
  }

  elements.openSlotCount.textContent = String(openSlotCount);
  elements.calendar.replaceChildren(heading, grid);
}

function createAvailabilityCell({ date, slot, locations, bookingsByLocationAndDate }) {
  const startMinute = slot.hour * 60 + slot.minute;
  const endMinute = startMinute + SLOT_MINUTES;
  const cell = createNode("div", "availability-cell");

  if (isPastSlot(date, startMinute)) {
    cell.classList.add("past-slot");
    cell.dataset.openCount = "0";
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }

  if (isBlockedTime(date, startMinute)) {
    cell.classList.add("business-hours");
    return cell;
  }

  if (locations.length === 0) {
    cell.classList.add("none");
    return cell;
  }

  let openCount = 0;

  for (const location of locations) {
    const courtCount = location.courts.length;
    const bookings = bookingsByLocationAndDate.get(location.id)?.get(date) ?? [];
    const busyCourts = new Set();

    for (const booking of bookings) {
      const bookingStart = minutesSinceDayStart(booking.starts_at, date);
      const bookingEnd = minutesSinceDayStart(booking.ends_at, date);

      if (bookingStart < endMinute && bookingEnd > startMinute) {
        busyCourts.add(booking.court_id);
      }
    }

    const available = Math.max(0, courtCount - busyCourts.size);
    const ratio = courtCount > 0 ? available / courtCount : 0;
    const chip = createNode("div", "location-chip");
    const availableLabel = available > 0 ? "✓" : "×";

    if (available === 0) {
      chip.classList.add("none");
    } else {
      chip.classList.add(ratio >= 0.5 ? "high" : "low");
      openCount += 1;
    }

    chip.title = `${location.label}: ${available}/${courtCount} courts at ${formatSlotTime(
      startMinute
    )}`;
    chip.append(createNode("strong", "", `${availableLabel} ${shortLocationName(location.label)}`));
    chip.append(createNode("span", "", `${available}/${courtCount}`));
    cell.append(chip);
  }

  cell.dataset.openCount = String(openCount);
  return cell;
}

function buildSlots(dates) {
  const slots = [];

  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
      const startMinute = hour * 60 + minute;

      if (dates.length === 0 || dates.every((date) => isPastSlot(date, startMinute))) {
        continue;
      }

      slots.push({ hour, minute });
    }
  }

  return slots;
}

function shiftWeek(delta) {
  const nextDate = parseDateInputValue(elements.dateInput.value);
  nextDate.setDate(nextDate.getDate() + delta * 7);
  elements.dateInput.value = maxDateString(toDateInputValue(nextDate), todayDateString());
  loadWeek();
}

function setStatus(message, state = "") {
  elements.status.textContent = message;
  elements.status.dataset.state = state;
}

function setLoading(isLoading) {
  elements.loadingOverlay.dataset.active = String(isLoading);
  elements.loadingOverlay.setAttribute("aria-hidden", String(!isLoading));
  elements.refreshButton.disabled = isLoading;
  elements.previousWeek.disabled = isLoading;
  elements.nextWeek.disabled = isLoading;
  elements.dateInput.disabled = isLoading;
}

function overlapsDate(booking, date) {
  return booking.starts_at.slice(0, 10) <= date && booking.ends_at.slice(0, 10) >= date;
}

function isBlockedTime(date, startMinute) {
  if (startMinute < MORNING_BLOCK_END_MINUTE) {
    return true;
  }

  const day = parseDateInputValue(date).getDay();
  const isWeekday = day >= 1 && day <= 5;
  return isWeekday && startMinute >= BUSINESS_START_MINUTE && startMinute < BUSINESS_END_MINUTE;
}

function isPastSlot(date, startMinute) {
  const today = todayDateString();

  if (date < today) {
    return true;
  }

  if (date > today) {
    return false;
  }

  return startMinute < currentSlotCutoffMinute();
}

function minutesSinceDayStart(value, date) {
  const valueDate = value.slice(0, 10);

  if (valueDate < date) {
    return 0;
  }

  if (valueDate > date) {
    return 24 * 60;
  }

  const match = value.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/);

  if (!match) {
    return 0;
  }

  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3] ?? 0) / 60;
}

function createNode(tagName, className = "", text = "") {
  const node = document.createElement(tagName);

  if (className) {
    node.className = className;
  }

  if (text) {
    node.textContent = text;
  }

  return node;
}

function toDateInputValue(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateString() {
  return toDateInputValue(new Date());
}

function maxDateString(left, right) {
  return left >= right ? left : right;
}

function currentSlotCutoffMinute() {
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes() + (now.getSeconds() > 0 ? 1 : 0);
  return Math.min(END_HOUR * 60, Math.ceil(minute / SLOT_MINUTES) * SLOT_MINUTES);
}

function parseDateInputValue(value) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatWeekRange(dates) {
  if (!dates?.length) {
    return "No upcoming dates";
  }

  return `${formatShortDate(dates[0])} - ${formatShortDate(dates.at(-1))}`;
}

function formatWeekday(value) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(parseDateInputValue(value));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    parseDateInputValue(value)
  );
}

function formatHour(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour} ${suffix}`;
}

function formatSlotTime(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatFetchedAt(value) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function newestFetchedAt(values) {
  const newest = values
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite)
    .sort((left, right) => right - left)[0];

  return newest ? new Date(newest).toISOString() : new Date().toISOString();
}

function shortLocationName(value) {
  return value
    .replace(/Badminton Centre/i, "")
    .replace(/Sports/i, "")
    .trim();
}
