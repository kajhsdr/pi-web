// 浏览器筛选与服务端分桶共用日期 key。不能从当地午夜减去固定毫秒数，
// 因为夏令时切换日不一定有 24 小时。
export function localUsageDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function usageWindowStart(today: string): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 89);
  return date.toISOString().slice(0, 10);
}

export function usageDateFormatter(timeZone: string): Intl.DateTimeFormat {
  // 较新的引擎中 Intl 也接受数字时区偏移，但此 API 要求使用 IANA 时区。
  if (!timeZone || timeZone.trim() !== timeZone || /^[+-]/.test(timeZone)) {
    throw new RangeError("Invalid IANA time zone");
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  });
}

export function usageDateKey(timestamp: string | number, formatter: Intl.DateTimeFormat): string | null {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = formatter.formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
