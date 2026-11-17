/**
 * Capture schedules: pure rules, no clock reads. A schedule is a cadence and an anchor (the first
 * run, chosen by a person in their own time zone and stored as an instant). Every later run is
 * the anchor plus whole periods, so runs keep the person's chosen time of day (in UTC terms) and
 * never drift. Missed runs (the app was down) collapse into one: the next run is always the first
 * one strictly after "now".
 */

export type Cadence = "daily" | "weekly" | "monthly";

const DAY = 86_400_000;

/** The anchor moved forward by `k` periods. Monthly keeps the anchor's UTC day, clamped to the month's length. */
export function nthRun(cadence: Cadence, anchorAt: number, k: number): number {
  if (cadence === "daily") return anchorAt + k * DAY;
  if (cadence === "weekly") return anchorAt + k * 7 * DAY;
  const a = new Date(anchorAt);
  const totalMonth = a.getUTCMonth() + k;
  const year = a.getUTCFullYear() + Math.floor(totalMonth / 12);
  const month = ((totalMonth % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(a.getUTCDate(), lastDay), a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds());
}

/** The first run strictly after `after` (the anchor itself if it is still ahead). */
export function nextRunAfter(cadence: Cadence, anchorAt: number, after: number): number {
  if (anchorAt > after) return anchorAt;
  if (cadence !== "monthly") {
    const period = cadence === "daily" ? DAY : 7 * DAY;
    return anchorAt + (Math.floor((after - anchorAt) / period) + 1) * period;
  }
  // Monthly: estimate, then step to the exact boundary (clamping makes periods uneven).
  let k = Math.max(1, Math.floor((after - anchorAt) / (31 * DAY)));
  while (nthRun(cadence, anchorAt, k) <= after) k++;
  while (k > 1 && nthRun(cadence, anchorAt, k - 1) > after) k--;
  return nthRun(cadence, anchorAt, k);
}
