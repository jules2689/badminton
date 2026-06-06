const SLOT_MINUTES = 30;
const SLOT_HEIGHT = 38;
const START_HOUR = 6;
const END_HOUR = 24;
const MORNING_BLOCK_END_MINUTE = 10 * 60;
const BUSINESS_START_MINUTE = 9 * 60;
const BUSINESS_END_MINUTE = 18 * 60;

const elements = {
  calendar: document.querySelector("#calendar"),
  calendarPanel: document.querySelector(".calendar-panel"),
  status: document.querySelector("#status"),
  loadingOverlay: document.querySelector("#loadingOverlay"),
  userBadge: document.querySelector("#userBadge"),
  userName: document.querySelector("#userName"),
  logoutButton: document.querySelector("#logoutButton"),
  dateInput: document.querySelector("#dateInput"),
  previousWeek: document.querySelector("#previousWeek"),
  nextWeek: document.querySelector("#nextWeek"),
  viewModeButtons: Array.from(document.querySelectorAll("[data-view-mode]")),
  refreshButton: document.querySelector("#refreshButton"),
  legendCalendar: document.querySelector(".legend-calendar"),
  legendOverview: document.querySelector(".legend-overview"),
  heatmapTooltip: document.querySelector("#heatmapTooltip")
};
const availabilityBySlot = new Map();
let currentUser = null;
let currentDates = [];
let currentPayload = null;
let groupAvailability = null;
let currentViewMode = "calendar";
let saveTimer = null;
let statusTimer = null;
const dragSelection = {
  active: false,
  paintStatus: null,
  paintedKeys: new Set()
};

elements.dateInput.min = todayDateString();
elements.logoutButton.addEventListener("click", () => {
  window.location.assign(appUrl("/logout"));
});
elements.previousWeek.addEventListener("click", () => shiftWeek(-1));
elements.nextWeek.addEventListener("click", () => shiftWeek(1));
elements.refreshButton.addEventListener("click", () => loadWeek({ updateUrl: false }));
for (const button of elements.viewModeButtons) {
  button.addEventListener("click", () => setViewMode(button.dataset.viewMode));
}
renderViewModeButtons();
elements.dateInput.addEventListener("change", () => {
  elements.dateInput.value = maxDateString(elements.dateInput.value, todayDateString());
  loadWeek({ replace: false });
});

window.addEventListener("popstate", (event) => {
  const date = normalizeUrlDate(event.state?.date ?? readDateFromUrl());
  const viewMode = normalizeViewMode(event.state?.view ?? readViewFromUrl());
  elements.dateInput.value = date;

  if (currentViewMode !== viewMode) {
    currentViewMode = viewMode;
    renderViewModeButtons();
  }

  loadWeek({ updateUrl: false });
});

document.addEventListener("pointerup", endDragPaint);
document.addEventListener("pointercancel", endDragPaint);
document.addEventListener("pointermove", (event) => {
  if (!dragSelection.active) {
    return;
  }

  const cell = document.elementFromPoint(event.clientX, event.clientY)?.closest(".availability-editable");

  if (cell) {
    applyPaintToCell(cell);
  }
});

initialize();

async function initialize() {
  try {
    await loadCurrentUser();
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Unable to load user", "error");
  }

  elements.dateInput.value = readDateFromUrl();
  currentViewMode = readViewFromUrl();
  renderViewModeButtons();

  await loadWeek({ replace: true });
}

async function fetchApi(path, options = {}) {
  const response = await fetch(appUrl(path), {
    credentials: "same-origin",
    ...options
  });

  return response;
}

async function loadWeek({ updateUrl = true, replace = false } = {}) {
  endDragPaint();
  hideHeatmapTooltip();
  setStatus("Loading availability");
  setLoading(true);

  try {
    const { start, days } = getSelectedWeekRequest();
    elements.dateInput.value = maxDateString(start, todayDateString());

    const response = await fetchApi(
      `/api/bookings?start=${encodeURIComponent(start)}&days=${encodeURIComponent(days)}`
    );

    if (!response.ok) {
      throw new Error(`Request failed with ${response.status}`);
    }

    const payload = await response.json();
    currentDates = payload.dates ?? [];
    currentPayload = payload;
    await Promise.all([loadUserAvailability(currentDates), loadGroupAvailability(currentDates)]);
    renderWeek(payload);
    updateStatus();

    if (updateUrl) {
      syncUrl({ replace });
    }
  } catch (error) {
    console.error(error);
    setStatus(error instanceof Error ? error.message : "Unable to load availability", "error");
    elements.calendar.replaceChildren();
  } finally {
    setLoading(false);
  }
}

function setViewMode(viewMode) {
  const nextViewMode = normalizeViewMode(viewMode);

  if (currentViewMode === nextViewMode) {
    return;
  }

  currentViewMode = nextViewMode;
  hideHeatmapTooltip();
  renderViewModeButtons();
  syncUrl({ replace: false });

  if (currentPayload) {
    renderWeek(currentPayload);
    updateStatus();
  }
}

function renderViewModeButtons() {
  for (const button of elements.viewModeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === currentViewMode));
  }

  if (elements.calendarPanel) {
    elements.calendarPanel.dataset.viewMode = currentViewMode;
  }

  if (elements.legendCalendar) {
    elements.legendCalendar.hidden = currentViewMode !== "calendar";
  }

  if (elements.legendOverview) {
    elements.legendOverview.hidden = currentViewMode !== "overview";
  }
}

function updateStatus() {
  const viewLabel =
    currentViewMode === "overview" ? "Overview" : "Choose your availability";
  setStatus(`${formatWeekRange(currentDates)} · ${viewLabel}`);
}

function renderWeek(payload) {
  const dates = currentDates;
  const locations = payload.locations ?? [];
  const slots = buildSlots(dates);
  const bookingsByLocationAndDate = buildBookingsByLocationAndDate(locations, dates);

  elements.calendar.dataset.viewMode = currentViewMode;
  elements.calendar.style.setProperty("--day-count", String(dates.length));
  elements.calendar.style.setProperty("--slot-height", `${SLOT_HEIGHT}px`);

  if (dates.length === 0) {
    elements.calendar.replaceChildren(
      createNode("div", "empty-state", "No upcoming dates in this range.")
    );
    return;
  }

  if (currentViewMode === "overview") {
    renderOverviewHeatmap({
      dates,
      slots,
      locations,
      bookingsByLocationAndDate
    });
    return;
  }

  renderCalendarGrid({
    dates,
    slots,
    locations,
    bookingsByLocationAndDate
  });
}

function renderCalendarGrid({ dates, slots, locations, bookingsByLocationAndDate }) {
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

      grid.append(cell);
    }
  }

  elements.calendar.replaceChildren(heading, grid);
}

function buildBookingsByLocationAndDate(locations, dates) {
  return new Map(
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
}

function getSlotAvailability({
  date,
  startMinute,
  endMinute,
  locations,
  bookingsByLocationAndDate
}) {
  let totalCourts = 0;
  let totalAvailable = 0;
  const locationSummaries = [];

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
    totalCourts += courtCount;
    totalAvailable += available;
    locationSummaries.push({
      label: location.label,
      available,
      courtCount
    });
  }

  const ratio = totalCourts > 0 ? totalAvailable / totalCourts : 0;
  const state = totalAvailable === 0 ? "none" : ratio >= 0.5 ? "high" : "low";

  return {
    state,
    totalAvailable,
    totalCourts,
    locationSummaries
  };
}

function renderOverviewHeatmap({ dates, slots, locations, bookingsByLocationAndDate }) {
  if (!groupAvailability || groupAvailability.users.length === 0) {
    elements.calendar.replaceChildren(
      createOverviewEmptyState("No one has signed in yet. Overview needs saved availability from your group.")
    );
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

  const grid = createNode("div", "heatmap-grid");
  let peakAvailable = 0;
  const respondedInWeek = getUsersRespondedInWeek(groupAvailability.windows);

  for (const slot of slots) {
    const timeCell = createNode("div", slot.minute === 0 ? "time-cell major" : "time-cell");
    timeCell.textContent = slot.minute === 0 ? formatHour(slot.hour) : "";
    grid.append(timeCell);

    for (const date of dates) {
      const startMinute = slot.hour * 60 + slot.minute;
      const endMinute = startMinute + SLOT_MINUTES;
      const summary = getOverviewSlotSummary(
        date,
        startMinute,
        endMinute,
        locations,
        bookingsByLocationAndDate,
        respondedInWeek
      );
      peakAvailable = Math.max(peakAvailable, summary.available.length);
      grid.append(createHeatmapCell({ date, startMinute, endMinute, summary }));
    }
  }

  const summaryBar = createNode("div", "overview-summary");
  summaryBar.append(
    createNode(
      "p",
      "overview-summary-lead",
      `${groupAvailability.users.length} player${groupAvailability.users.length === 1 ? "" : "s"} tracked`
    )
  );
  summaryBar.append(
    createNode(
      "p",
      "overview-summary-meta",
      peakAvailable > 0
        ? `Busiest slot: ${peakAvailable} available · hover any cell for names`
        : "No availability marked this week · hover cells to see who has not responded"
    )
  );

  const view = createNode("div", "overview-view");
  view.append(summaryBar, heading, grid);
  elements.calendar.replaceChildren(view);
}

function createOverviewEmptyState(message) {
  const empty = createNode("div", "overview-empty");
  empty.append(createNode("p", "overview-empty-title", "Group availability unavailable"));
  empty.append(createNode("p", "overview-empty-copy", message));
  return empty;
}

function createHeatmapCell({ date, startMinute, endMinute, summary }) {
  const cell = createNode("div", "heatmap-cell");
  cell.style.setProperty("--heat", "0");
  cell.tabIndex = isHeatmapCellInteractive(date, startMinute) ? 0 : -1;
  cell.setAttribute(
    "aria-label",
    formatHeatmapCellLabel(date, startMinute, summary)
  );

  if (isPastSlot(date, startMinute)) {
    cell.classList.add("past-slot");
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }

  if (isBlockedTime(date, startMinute)) {
    cell.classList.add("business-hours");
    return cell;
  }

  appendHeatmapCellSignal(cell, summary);

  if (isHeatmapCellInteractive(date, startMinute)) {
    cell.addEventListener("pointerenter", (event) => {
      showHeatmapTooltip(cell, summary, date, startMinute, event);
    });
    cell.addEventListener("pointermove", (event) => {
      positionHeatmapTooltip(event.clientX, event.clientY);
    });
    cell.addEventListener("pointerleave", hideHeatmapTooltip);
    cell.addEventListener("focus", () => {
      showHeatmapTooltip(cell, summary, date, startMinute);
    });
    cell.addEventListener("blur", hideHeatmapTooltip);
  }

  return cell;
}

function appendHeatmapCellSignal(cell, summary) {
  const totalUsers = summary.totalUsers;

  if (totalUsers === 0) {
    return;
  }

  const signals = createNode("div", "heatmap-signals");
  const hasAvailable = summary.available.length > 0;
  const hasMaybe = summary.maybe.length > 0;
  const hasUnset = summary.unset.length > 0;
  const hasUnavailable = summary.unavailable.length > 0;

  if (hasAvailable) {
    const heat = summary.available.length / totalUsers;
    cell.style.setProperty("--heat", heat.toFixed(3));
    cell.classList.add("heatmap-has-available");
    signals.append(createHeatmapSignal("available", heat));
  } else if (hasMaybe) {
    const heat = summary.maybe.length / totalUsers;
    cell.style.setProperty("--heat", heat.toFixed(3));
    cell.classList.add("heatmap-maybe-only");
    signals.append(createHeatmapSignal("maybe", heat));
  } else if (hasUnset) {
    const heat = summary.unset.length / totalUsers;
    cell.style.setProperty("--unset-heat", heat.toFixed(3));
    cell.classList.add("heatmap-unset-only");
    signals.append(createHeatmapSignal("unset", heat));
  } else if (hasUnavailable) {
    cell.classList.add("heatmap-unavailable-only");
    signals.append(createHeatmapSignal("unavailable", 1));
  }

  if (hasMaybe && hasAvailable) {
    signals.append(
      createHeatmapSignal("maybe", summary.maybe.length / totalUsers, { secondary: true })
    );
  }

  if (hasUnset && (hasAvailable || hasMaybe)) {
    signals.append(
      createHeatmapSignal("unset", summary.unset.length / totalUsers, { secondary: true })
    );
  }

  if (hasUnavailable && (hasAvailable || hasMaybe || hasUnset)) {
    signals.append(
      createHeatmapSignal("unavailable", summary.unavailable.length / totalUsers, {
        secondary: true
      })
    );
  }

  if (signals.childNodes.length > 0) {
    cell.append(signals);
  }
}

function createHeatmapSignal(kind, strength, { secondary = false } = {}) {
  const signal = createNode(
    "span",
    `heatmap-signal heatmap-signal-${kind}${secondary ? " heatmap-signal-secondary" : ""}`
  );
  signal.style.setProperty("--signal-strength", strength.toFixed(3));
  signal.setAttribute("aria-hidden", "true");
  signal.textContent =
    kind === "available" ? "✓" : kind === "maybe" ? "?" : kind === "unset" ? "—" : "×";
  return signal;
}

function isHeatmapCellInteractive(date, startMinute) {
  return !isPastSlot(date, startMinute) && !isBlockedTime(date, startMinute);
}

function getOverviewSlotSummary(
  date,
  startMinute,
  endMinute,
  locations,
  bookingsByLocationAndDate,
  respondedInWeek
) {
  const summary = getGroupSlotSummary(date, startMinute, endMinute, respondedInWeek);
  summary.courtAvailability =
    locations.length > 0
      ? getSlotAvailability({
          date,
          startMinute,
          endMinute,
          locations,
          bookingsByLocationAndDate
        })
      : null;
  return summary;
}

function getGroupSlotSummary(date, startMinute, endMinute, respondedInWeek) {
  const users = groupAvailability?.users ?? [];
  const windows = groupAvailability?.windows ?? [];
  const available = [];
  const maybe = [];
  const unavailable = [];
  const unset = [];

  for (const user of users) {
    const status = getUserStatusForSlot(user.id, date, startMinute, endMinute, windows);

    if (status === "available") {
      available.push(user.display_name);
    } else if (status === "maybe") {
      maybe.push(user.display_name);
    } else if (status === "unavailable" || respondedInWeek.has(user.id)) {
      unavailable.push(user.display_name);
    } else {
      unset.push(user.display_name);
    }
  }

  return {
    totalUsers: users.length,
    available,
    maybe,
    unavailable,
    unset
  };
}

function getUsersRespondedInWeek(windows) {
  return new Set(windows.map((window) => window.user_id));
}

function getUserStatusForSlot(userId, date, startMinute, endMinute, windows) {
  let matchedStatus = null;

  for (const window of windows) {
    if (window.user_id !== userId) {
      continue;
    }

    const windowDate = window.starts_at.slice(0, 10);

    if (windowDate !== date) {
      continue;
    }

    const windowStart = minutesSinceDayStart(window.starts_at, date);
    const windowEnd = minutesSinceDayStart(window.ends_at, date);

    if (windowStart < endMinute && windowEnd > startMinute) {
      if (window.status === "available") {
        return "available";
      }

      matchedStatus = window.status;
    }
  }

  return matchedStatus;
}

function formatHeatmapCellLabel(date, startMinute, summary) {
  const parts = [
    `${formatWeekday(date)} ${formatShortDate(date)} ${formatSlotTime(startMinute)}`,
    `${summary.available.length} available`,
    `${summary.maybe.length} maybe`,
    `${summary.unset.length} no response`
  ];

  if (summary.unavailable.length > 0) {
    parts.push(`${summary.unavailable.length} cannot attend`);
  }

  if (summary.courtAvailability) {
    parts.push(formatCourtAvailabilityLabel(summary.courtAvailability));
  }

  return parts.join(", ");
}

function formatCourtAvailabilityLabel(courtAvailability) {
  if (!courtAvailability?.locationSummaries.length) {
    return "No court data";
  }

  return courtAvailability.locationSummaries
    .map(
      (location) =>
        `${shortLocationName(location.label) || location.label} ${location.available}/${location.courtCount}`
    )
    .join(", ");
}

function showHeatmapTooltip(cell, summary, date, startMinute, event) {
  if (!elements.heatmapTooltip) {
    return;
  }

  elements.heatmapTooltip.replaceChildren();
  elements.heatmapTooltip.hidden = false;
  elements.heatmapTooltip.append(
    createNode(
      "p",
      "heatmap-tooltip-title",
      `${formatWeekday(date)} ${formatShortDate(date)} · ${formatSlotTime(startMinute)}`
    )
  );

  appendHeatmapTooltipGroup(summary.available, "Available", "heatmap-tooltip-available");
  appendHeatmapTooltipGroup(summary.maybe, "Maybe", "heatmap-tooltip-maybe");
  appendHeatmapTooltipGroup(summary.unavailable, "Cannot attend", "heatmap-tooltip-unavailable");
  appendHeatmapTooltipGroup(summary.unset, "No response", "heatmap-tooltip-unset");
  appendHeatmapTooltipCourts(summary.courtAvailability);

  if (event) {
    positionHeatmapTooltip(event.clientX, event.clientY);
  } else {
    const rect = cell.getBoundingClientRect();
    positionHeatmapTooltip(rect.left + rect.width / 2, rect.top);
  }
}

function appendHeatmapTooltipCourts(courtAvailability) {
  if (!elements.heatmapTooltip || !courtAvailability?.locationSummaries.length) {
    return;
  }

  const group = createNode("div", "heatmap-tooltip-group heatmap-tooltip-courts");
  group.append(createNode("p", "heatmap-tooltip-heading", "Courts"));
  group.append(createSlotLocationsElement(courtAvailability.locationSummaries));
  elements.heatmapTooltip.append(group);
}

function appendHeatmapTooltipGroup(names, label, className) {
  if (!elements.heatmapTooltip || names.length === 0) {
    return;
  }

  const group = createNode("div", `heatmap-tooltip-group ${className}`);
  group.append(createNode("p", "heatmap-tooltip-heading", `${label} (${names.length})`));
  group.append(createNode("p", "heatmap-tooltip-names", names.join(", ")));
  elements.heatmapTooltip.append(group);
}

function positionHeatmapTooltip(clientX, clientY) {
  if (!elements.heatmapTooltip || elements.heatmapTooltip.hidden) {
    return;
  }

  const margin = 14;
  const tooltip = elements.heatmapTooltip;
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const { width, height } = tooltip.getBoundingClientRect();
  const maxLeft = window.innerWidth - width - margin;
  const maxTop = window.innerHeight - height - margin;
  const left = Math.min(Math.max(clientX + margin, margin), maxLeft);
  const top = Math.min(Math.max(clientY + margin, margin), maxTop);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideHeatmapTooltip() {
  if (!elements.heatmapTooltip) {
    return;
  }

  elements.heatmapTooltip.hidden = true;
  elements.heatmapTooltip.replaceChildren();
}

function createAvailabilityCell({ date, slot, locations, bookingsByLocationAndDate }) {
  const startMinute = slot.hour * 60 + slot.minute;
  const endMinute = startMinute + SLOT_MINUTES;
  const cell = createNode("div", "availability-cell");

  if (isPastSlot(date, startMinute)) {
    cell.classList.add("past-slot");
    cell.setAttribute("aria-hidden", "true");
    return cell;
  }

  if (isBlockedTime(date, startMinute)) {
    cell.classList.add("business-hours");
    return cell;
  }

  prepareUserAvailabilityCell(cell, date, startMinute, endMinute);

  if (locations.length === 0) {
    cell.classList.add("none");
    return cell;
  }

  const availability = getSlotAvailability({
    date,
    startMinute,
    endMinute,
    locations,
    bookingsByLocationAndDate
  });

  cell.classList.add(`availability-${availability.state}`);
  cell.dataset.availabilityLabel = `${availabilityStateLabel(availability.state)}: ${
    availability.totalAvailable
  }/${availability.totalCourts} courts at ${formatSlotTime(startMinute)}`;

  if (availability.locationSummaries.length > 0) {
    cell.append(createSlotLocationsElement(availability.locationSummaries));
  }

  updateCellTitle(cell);
  return cell;
}

function createSlotLocationsElement(locationSummaries) {
  const locations = createNode("div", "slot-locations");

  for (const [index, location] of locationSummaries.entries()) {
    if (index > 0) {
      locations.append(createNode("span", "slot-location-sep", "·"));
    }

    const item = createNode("span", "slot-location");
    item.append(
      createNode(
        "span",
        location.available > 0 ? "location-mark location-mark-open" : "location-mark location-mark-full",
        location.available > 0 ? "✓" : "×"
      )
    );
    item.append(
      createNode("span", "", `${shortLocationName(location.label)} ${location.available}/${location.courtCount}`)
    );
    item.title = `${location.label}: ${location.available}/${location.courtCount} courts`;
    locations.append(item);
  }

  return locations;
}

function buildSlots(dates) {
  const slots = [];

  for (let hour = START_HOUR; hour < END_HOUR; hour += 1) {
    for (let minute = 0; minute < 60; minute += SLOT_MINUTES) {
      slots.push({ hour, minute });
    }
  }

  return slots;
}

function shiftWeek(delta) {
  const nextDate = parseDateInputValue(startOfWeekSunday(elements.dateInput.value));
  nextDate.setDate(nextDate.getDate() + delta * 7);
  elements.dateInput.value = maxDateString(toDateInputValue(nextDate), todayDateString());
  loadWeek({ replace: false });
}

function readDateFromUrl() {
  const value = new URLSearchParams(window.location.search).get("date");

  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return normalizeUrlDate(value);
  }

  return todayDateString();
}

function readViewFromUrl() {
  return normalizeViewMode(new URLSearchParams(window.location.search).get("view"));
}

function normalizeViewMode(value) {
  if (value === "overview" || value === "open-times") {
    return "overview";
  }

  return "calendar";
}

function normalizeUrlDate(value) {
  return maxDateString(startOfWeekSunday(value), todayDateString());
}

function syncUrl({ replace = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("date", normalizeUrlDate(elements.dateInput.value));

  if (currentViewMode === "overview") {
    url.searchParams.set("view", "overview");
  } else {
    url.searchParams.delete("view");
  }

  if (url.href === window.location.href) {
    return;
  }

  const state = {
    date: url.searchParams.get("date"),
    view: currentViewMode
  };

  if (replace) {
    history.replaceState(state, "", url);
  } else {
    history.pushState(state, "", url);
  }
}

function getSelectedWeekRequest() {
  const selectedDate = maxDateString(elements.dateInput.value, todayDateString());
  const weekStart = startOfWeekSunday(selectedDate);

  return {
    start: weekStart,
    days: 7
  };
}

function setStatus(message, state = "") {
  window.clearTimeout(statusTimer);
  statusTimer = null;
  elements.status.textContent = message;
  elements.status.dataset.state = state;
}

function showSavedStatus() {
  setStatus(`${formatWeekRange(currentDates)} · saved`);
  statusTimer = window.setTimeout(() => {
    setStatus(formatWeekRange(currentDates));
    statusTimer = null;
  }, 2000);
}

function setLoading(isLoading) {
  elements.loadingOverlay.dataset.active = String(isLoading);
  elements.loadingOverlay.setAttribute("aria-hidden", String(!isLoading));
  elements.refreshButton.disabled = isLoading;
  elements.previousWeek.disabled = isLoading;
  elements.nextWeek.disabled = isLoading;
  elements.dateInput.disabled = isLoading;
  elements.logoutButton.disabled = isLoading;
  for (const button of elements.viewModeButtons) {
    button.disabled = isLoading;
  }
}

async function loadCurrentUser() {
  const response = await fetchApi("/api/me");

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed with ${response.status}`);
  }

  const { user } = await response.json();
  currentUser = user;
  renderUserState();
}

async function loadUserAvailability(dates) {
  availabilityBySlot.clear();

  if (dates.length === 0) {
    return;
  }

  const response = await fetchApi(
    `/api/availability?start=${encodeURIComponent(dates[0])}&days=${dates.length}`
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed with ${response.status}`);
  }

  const { windows } = await response.json();

  for (const window of windows ?? []) {
    const date = window.starts_at.slice(0, 10);
    const minute = minutesSinceDayStart(window.starts_at, date);
    availabilityBySlot.set(slotKey(date, minute), window.status);
  }
}

async function loadGroupAvailability(dates) {
  groupAvailability = null;

  if (dates.length === 0) {
    return;
  }

  const response = await fetchApi(
    `/api/availability/group?start=${encodeURIComponent(dates[0])}&days=${dates.length}`
  );

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed with ${response.status}`);
  }

  groupAvailability = await response.json();
}

function prepareUserAvailabilityCell(cell, date, startMinute, endMinute) {
  const key = slotKey(date, startMinute);
  const status = availabilityBySlot.get(key);

  cell.classList.add("availability-editable");
  cell.tabIndex = 0;
  cell.setAttribute("role", "button");
  cell.dataset.slotKey = key;
  cell.dataset.startsAt = minuteToTimestamp(date, startMinute);
  cell.dataset.endsAt = minuteToTimestamp(date, endMinute);
  cell.dataset.userStatus = status ?? "";
  cell.setAttribute("aria-label", formatUserAvailabilityLabel(date, startMinute, status));
  cell.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    beginDragPaint(cell);
  });
  cell.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleUserAvailability(key, cell);
    }
  });
}

function nextAvailabilityStatus(current) {
  return current === "available" ? "maybe" : current === "maybe" ? null : "available";
}

function beginDragPaint(cell) {
  if (!cell.classList.contains("availability-editable")) {
    return;
  }

  const key = cell.dataset.slotKey;
  dragSelection.active = true;
  dragSelection.paintStatus = nextAvailabilityStatus(availabilityBySlot.get(key));
  dragSelection.paintedKeys.clear();
  document.body.classList.add("availability-dragging");
  applyPaintToCell(cell);
}

function applyPaintToCell(cell) {
  if (!dragSelection.active || !cell.classList.contains("availability-editable")) {
    return;
  }

  const key = cell.dataset.slotKey;

  if (dragSelection.paintedKeys.has(key)) {
    return;
  }

  dragSelection.paintedKeys.add(key);
  setUserAvailability(key, cell, dragSelection.paintStatus);
}

function endDragPaint() {
  if (!dragSelection.active) {
    return;
  }

  dragSelection.active = false;
  dragSelection.paintStatus = null;
  dragSelection.paintedKeys.clear();
  document.body.classList.remove("availability-dragging");
}

function setUserAvailability(key, cell, status) {
  if (status) {
    availabilityBySlot.set(key, status);
  } else {
    availabilityBySlot.delete(key);
  }

  cell.dataset.userStatus = status ?? "";
  updateCellTitle(cell);
  cell.setAttribute(
    "aria-label",
    formatUserAvailabilityLabel(
      cell.dataset.startsAt.slice(0, 10),
      minutesSinceDayStart(cell.dataset.startsAt, cell.dataset.startsAt.slice(0, 10)),
      status
    )
  );
  scheduleAvailabilitySave();
}

function toggleUserAvailability(key, cell) {
  setUserAvailability(key, cell, nextAvailabilityStatus(availabilityBySlot.get(key)));
}

function scheduleAvailabilitySave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveAvailability().catch((error) => {
      console.error(error);
      setStatus(error instanceof Error ? error.message : "Unable to save availability", "error");
    });
  }, 350);
}

async function saveAvailability() {
  if (currentDates.length === 0) {
    return;
  }

  const windows = Array.from(availabilityBySlot.entries()).map(([key, status]) => {
    const [date, minuteText] = key.split("|");
    const startMinute = Number(minuteText);

    return {
      starts_at: minuteToTimestamp(date, startMinute),
      ends_at: minuteToTimestamp(date, startMinute + SLOT_MINUTES),
      status
    };
  });
  const saveStart = maxDateString(currentDates[0], todayDateString());
  const saveDays = daysBetween(saveStart, currentDates.at(-1)) + 1;
  const response = await fetchApi("/api/availability", {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      start: saveStart,
      days: saveDays,
      windows
    })
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message ?? `Request failed with ${response.status}`);
  }

  showSavedStatus();
}

function renderUserState() {
  if (currentUser) {
    elements.userName.textContent = currentUser.display_name;
    elements.userBadge.hidden = false;
    return;
  }

  elements.userBadge.hidden = true;
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

  const match = value.match(/(?:T|\s)(\d{2}):(\d{2})(?::(\d{2}))?/);

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

function appUrl(path) {
  const url = new URL(path, window.location.href);
  url.username = "";
  url.password = "";
  return url;
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

function slotKey(date, minute) {
  return `${date}|${minute}`;
}

function minuteToTimestamp(date, minute) {
  const targetDate = addDays(date, Math.floor(minute / (24 * 60)));
  const minuteInDay = minute % (24 * 60);
  const hour = Math.floor(minuteInDay / 60);
  const minutePart = minuteInDay % 60;

  return `${targetDate}T${String(hour).padStart(2, "0")}:${String(minutePart).padStart(
    2,
    "0"
  )}:00`;
}

function addDays(value, days) {
  const date = parseDateInputValue(value);
  date.setDate(date.getDate() + days);
  return toDateInputValue(date);
}

function startOfWeekSunday(value) {
  const date = parseDateInputValue(value);
  date.setDate(date.getDate() - date.getDay());
  return toDateInputValue(date);
}

function daysBetween(start, end) {
  const [startYear, startMonth, startDay] = start.split("-").map(Number);
  const [endYear, endMonth, endDay] = end.split("-").map(Number);
  const startMs = Date.UTC(startYear, startMonth - 1, startDay);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay);
  return Math.max(0, Math.round((endMs - startMs) / 86_400_000));
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

function formatUserAvailabilityLabel(date, startMinute, status) {
  const label = `${formatWeekday(date)} ${formatShortDate(date)} ${formatSlotTime(startMinute)}`;

  return status ? `${label}, marked ${status}` : `${label}, not marked`;
}

function updateCellTitle(cell) {
  const parts = [];

  if (cell.dataset.availabilityLabel) {
    parts.push(cell.dataset.availabilityLabel);
  }

  const status = cell.dataset.userStatus;

  if (status) {
    parts.push(`You marked ${status}`);
  } else if (cell.classList.contains("availability-editable")) {
    parts.push("Click or drag to mark your availability");
  }

  cell.title = parts.join(" · ");
}

function availabilityStatusIcon(state) {
  switch (state) {
    case "high":
      return "✓";
    case "low":
      return "!";
    case "none":
    default:
      return "×";
  }
}

function availabilityStateLabel(state) {
  switch (state) {
    case "high":
      return "High availability";
    case "low":
      return "Limited availability";
    case "none":
    default:
      return "No availability";
  }
}

function shortLocationName(value) {
  return value
    .replace(/Badminton Centre/i, "")
    .replace(/Sports/i, "")
    .trim();
}
