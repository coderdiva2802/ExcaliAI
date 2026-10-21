// ─────────────────────────────────────────────────────────
// Date parsing for scaled timelines → fractional years.
// Accepts: 1914, -500, "1914", "1914-07-28", "1914-07",
// "500 BCE"/"500 BC", "AD 79", "c. 1450", "1450s".
// ─────────────────────────────────────────────────────────

const DAYS_BEFORE_MONTH = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

export function parseYear(value: number | string): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = value.trim().toLowerCase().replace(/^(c\.|ca\.|circa|~)\s*/, "");
  const bce = /\b(bce|bc|b\.c\.|b\.c\.e\.)\s*$/.test(s);
  s = s.replace(/\b(bce|bc|b\.c\.e?\.?|ce|ad|a\.d\.)\b\.?/g, "").trim();
  const iso = /^(-?\d{1,4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(s);
  if (iso) {
    const year = parseInt(iso[1], 10);
    const month = Math.min(12, Math.max(1, parseInt(iso[2], 10)));
    const day = iso[3] ? Math.min(31, Math.max(1, parseInt(iso[3], 10))) : 1;
    return year + (DAYS_BEFORE_MONTH[month - 1] + day - 1) / 365;
  }
  const decade = /^(\d{3,4})s$/.exec(s);
  if (decade) return parseInt(decade[1], 10) + 5;
  const plain = /^-?\d{1,6}(\.\d+)?$/.exec(s);
  if (plain) {
    const year = parseFloat(plain[0]);
    return bce ? -Math.abs(year) : year;
  }
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Label for an axis tick or event, adapted to the span being shown. */
export function formatYear(year: number, span: number): string {
  if (span < 3) {
    const y = Math.floor(year);
    const dayOfYear = Math.round((year - y) * 365);
    let month = 0;
    DAYS_BEFORE_MONTH.forEach((d, i) => {
      if (d <= dayOfYear) month = i;
    });
    return `${MONTHS[month]} ${y}`;
  }
  // Floor, never round: 28 Jul 1914 (≈1914.57) is still 1914.
  const y = Math.floor(year + 1e-9);
  return y < 0 ? `${-y} BCE` : String(y);
}

/** Human date for an event card, keeping the precision the source gave (day, month or year). */
export function formatEventDate(value: number | string, year: number): string {
  if (typeof value === "string") {
    const iso = /^\s*(-?\d{1,4})-(\d{1,2})(?:-(\d{1,2}))?\s*$/.exec(value);
    if (iso) {
      const month = MONTHS[Math.min(12, Math.max(1, parseInt(iso[2], 10))) - 1];
      const y = parseInt(iso[1], 10);
      const yText = y < 0 ? `${-y} BCE` : String(y);
      return iso[3] ? `${parseInt(iso[3], 10)} ${month} ${yText}` : `${month} ${yText}`;
    }
  }
  return formatYear(year, 100);
}
