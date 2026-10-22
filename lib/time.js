// Time-zone helpers (no libraries): convert between UTC and a wall-clock time in an IANA zone.

export function validTimeZone(tz) {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Wall-clock parts of a UTC instant in a zone.
export function partsInZone(ms, tz) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short",
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wd = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday: wd };
}

// UTC ms for a wall-clock time in a zone.
export function zonedToUtc(y, m, d, h, min, tz) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = partsInZone(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const diff = asUtc - Date.UTC(y, m - 1, d, h, min);
    if (diff === 0) break;
    guess -= diff;
  }
  return guess;
}

export function localNowString(tz, ms = Date.now()) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toUTCString();
  }
}

// Next run time (UTC ms) strictly after `after` for a schedule:
//   {freq:"hourly"} | {freq:"daily", time:"08:00"} | {freq:"weekly", time:"08:00", days:[1..7]} | {freq:"once", at: ms}
export function nextRun(schedule, after = Date.now()) {
  const tz = validTimeZone(schedule.tz) ? schedule.tz : "UTC";
  if (schedule.freq === "once") return schedule.at > after ? schedule.at : null;
  if (schedule.freq === "hourly") {
    const minute = Number(String(schedule.time || "00:00").split(":")[1] || 0);
    const p = partsInZone(after, tz);
    let t = zonedToUtc(p.y, p.m, p.d, p.h, minute, tz);
    while (t <= after) t += 3600000;
    return t;
  }
  const [hh, mm] = String(schedule.time || "08:00").split(":").map(Number);
  const days = schedule.freq === "weekly" && Array.isArray(schedule.days) && schedule.days.length ? schedule.days : [1, 2, 3, 4, 5, 6, 7];
  const start = partsInZone(after, tz);
  for (let i = 0; i < 8; i++) {
    const base = new Date(Date.UTC(start.y, start.m - 1, start.d + i, 12));
    const y = base.getUTCFullYear(), m = base.getUTCMonth() + 1, d = base.getUTCDate();
    const t = zonedToUtc(y, m, d, hh || 0, mm || 0, tz);
    const wd = partsInZone(t, tz).weekday;
    if (t > after && days.includes(wd)) return t;
  }
  return null;
}

export function describeSchedule(s) {
  const t = s.time || "08:00";
  const names = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  if (s.freq === "hourly") return `Every hour at :${String(t.split(":")[1] || "00").padStart(2, "0")}`;
  if (s.freq === "daily") return `Every day at ${t} (${s.tz})`;
  if (s.freq === "weekly") return `Every ${(s.days || []).map((d) => names[d]).join(", ")} at ${t} (${s.tz})`;
  if (s.freq === "once") return `Once, ${localNowString(s.tz, s.at)}`;
  return "Custom";
}
