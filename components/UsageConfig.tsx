"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ConfigPanelShell, ConfigSectionTitle } from "./SettingsUi";
import type { UsageBucketRow, UsageSnapshot, UsageTokens, UsageTotals } from "@/lib/api-types";

/** 小额要看到四位小数，量级上去了收成两位，和官方账单的读法一致。 */
function formatMoney(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(5)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(Math.round(value));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function pad(value: number): string {
  return `${value}`.padStart(2, "0");
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function emptyTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

function emptyTotals(): UsageTotals {
  return { tokens: emptyTokens(), cost: 0, calls: 0 };
}

/** 按某个字段分组合计，结果按费用降序。 */
function groupTotals(
  rows: UsageBucketRow[],
  key: (row: UsageBucketRow) => string,
): { key: string; totals: UsageTotals }[] {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const id = key(row);
    let totals = groups.get(id);
    if (!totals) {
      totals = emptyTotals();
      groups.set(id, totals);
    }
    totals.tokens.input += row.tokens.input;
    totals.tokens.output += row.tokens.output;
    totals.tokens.cacheRead += row.tokens.cacheRead;
    totals.tokens.cacheWrite += row.tokens.cacheWrite;
    totals.tokens.total += row.tokens.total;
    totals.cost += row.cost;
    totals.calls += row.calls;
  }
  return [...groups.entries()]
    .map(([id, totals]) => ({ key: id, totals }))
    .sort((a, b) => b.totals.cost - a.totals.cost);
}

/** 项目只显示最后一段目录名，完整路径放 title。 */
function projectLabel(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function SummaryCard({ label, totals }: { label: string; totals: UsageTotals }) {
  const { t } = useI18n();
  return (
    <div className="usage-card">
      <div className="usage-card-label">{label}</div>
      <div className="usage-card-value">{formatMoney(totals.cost)}</div>
      <div className="usage-card-meta">
        {t("usage.cardMeta", {
          calls: formatCount(totals.calls),
          tokens: formatTokens(totals.tokens.total),
        })}
      </div>
      <div className="usage-card-meta">
        {t("usage.cardBreakdown", {
          input: formatTokens(totals.tokens.input),
          cache: formatTokens(totals.tokens.cacheRead),
          output: formatTokens(totals.tokens.output),
        })}
      </div>
    </div>
  );
}

/** GitHub 那种方格图：一列一周，一行一天，颜色按当日 token 量分四档。
 *  颜色全部用主题变量拼，暗色主题下才跟着 --accent 走。 */
function UsageHeatmap({ rows }: { rows: { key: string; totals: UsageTotals }[] }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState<{ key: string; totals: UsageTotals } | null>(null);
  // 触屏没有 hover：点一下（或键盘聚焦）就把读数留在原地。
  const [picked, setPicked] = useState<{ key: string; totals: UsageTotals } | null>(null);

  const cells = useMemo(() => {
    const byDate = new Map(rows.map((row) => [row.key, row.totals]));
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end);
    start.setDate(start.getDate() - (26 * 7 - 1));
    start.setDate(start.getDate() - start.getDay()); // 对齐到周日，一列正好一周
    const out: { key: string; totals: UsageTotals }[] = [];
    for (const cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
      const key = localDateKey(cursor);
      out.push({ key, totals: byDate.get(key) ?? emptyTotals() });
    }
    return out;
  }, [rows]);

  const peak = Math.max(...cells.map((cell) => cell.totals.tokens.total), 1);
  const shades = [
    "var(--bg-hover)",
    "color-mix(in srgb, var(--accent) 28%, transparent)",
    "color-mix(in srgb, var(--accent) 50%, transparent)",
    "color-mix(in srgb, var(--accent) 75%, transparent)",
    "var(--accent)",
  ];
  const active = hovered ?? picked;

  const pick = (cell: { key: string; totals: UsageTotals }) => setPicked(cell);

  return (
    <div className="usage-heatmap-block">
      <div className="usage-heatmap" role="group" aria-label={t("usage.heatmap")}>
        {cells.map((cell) => {
          const tokens = cell.totals.tokens.total;
          const level = tokens === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / peak) * 4)));
          return (
            <div
              key={cell.key}
              className={`usage-heatmap-cell${active?.key === cell.key ? " is-active" : ""}`}
              style={{ background: shades[level] }}
              tabIndex={0}
              role="button"
              aria-label={t("usage.heatmapDay", {
                date: cell.key,
                cost: formatMoney(cell.totals.cost),
                tokens: formatTokens(tokens),
              })}
              onMouseEnter={() => setHovered(cell)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => pick(cell)}
              onClick={() => pick(cell)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  pick(cell);
                }
              }}
            />
          );
        })}
      </div>
      <div className="usage-heatmap-foot">
        <span className="usage-heatmap-readout">
          {active
            ? t("usage.heatmapReadout", {
                date: active.key,
                cost: formatMoney(active.totals.cost),
                tokens: formatTokens(active.totals.tokens.total),
                calls: formatCount(active.totals.calls),
              })
            : t("usage.heatmapHint")}
        </span>
        <span className="usage-heatmap-scale">
          {t("usage.less")}
          {shades.map((color) => (
            <span key={color} className="usage-heatmap-cell" style={{ background: color }} />
          ))}
          {t("usage.more")}
        </span>
      </div>
    </div>
  );
}

function TotalsTable({
  rows,
  firstHeader,
  labelOf,
  emptyLabel,
  limit = 12,
}: {
  rows: { key: string; totals: UsageTotals }[];
  firstHeader: string;
  labelOf: (key: string) => string;
  emptyLabel: string;
  limit?: number;
}) {
  const { t } = useI18n();
  if (rows.length === 0) return <div className="usage-empty">{emptyLabel}</div>;
  const totalCost = rows.reduce((sum, row) => sum + row.totals.cost, 0);
  return (
    <table className="usage-table">
      <thead>
        <tr>
          <th>{firstHeader}</th>
          <th className="num">{t("usage.calls")}</th>
          <th className="num">tokens</th>
          <th className="num">{t("usage.cost")}</th>
          <th className="num">{t("usage.share")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, limit).map((row) => (
          <tr key={row.key}>
            <td title={row.key}>{labelOf(row.key)}</td>
            <td className="num">{formatCount(row.totals.calls)}</td>
            <td className="num">{formatTokens(row.totals.tokens.total)}</td>
            <td className="num">{formatMoney(row.totals.cost)}</td>
            <td className="num">{totalCost > 0 ? `${Math.round((row.totals.cost / totalCost) * 100)}%` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function UsageConfig({ embedded = false, onClose }: { embedded?: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const [data, setData] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState("all");
  const [model, setModel] = useState("all");
  const [range, setRange] = useState<"today" | "90d">("today");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/usage");
      const next = (await res.json()) as UsageSnapshot & { error?: string };
      if (!res.ok || next.error) throw new Error(next.error ?? `HTTP ${res.status}`);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const buckets = useMemo(() => data?.buckets ?? [], [data?.buckets]);

  // 下拉选项来自全部数据，这样筛了项目还能切模型。
  const projectOptions = useMemo(
    () => [...new Set(buckets.map((row) => row.cwd).filter(Boolean))].sort(),
    [buckets],
  );
  const modelOptions = useMemo(
    () => [...new Set(buckets.map((row) => row.model))].sort(),
    [buckets],
  );

  const filtered = useMemo(
    () =>
      buckets.filter(
        (row) => (project === "all" || row.cwd === project) && (model === "all" || row.model === model),
      ),
    [buckets, project, model],
  );

  const todayKey = localDateKey(new Date());
  const monthKey = todayKey.slice(0, 7);
  // 「近 90 天」要真有下限，否则按钮文案在说谡。
  const windowStart = useMemo(() => localDateKey(new Date(Date.now() - 89 * 86_400_000)), []);

  const totals = useMemo(() => {
    const today = emptyTotals();
    const month = emptyTotals();
    const all = emptyTotals();
    for (const row of filtered) {
      for (const [target, hit] of [
        [all, true],
        [month, row.date.slice(0, 7) === monthKey],
        [today, row.date === todayKey],
      ] as [UsageTotals, boolean][]) {
        if (!hit) continue;
        target.tokens.input += row.tokens.input;
        target.tokens.output += row.tokens.output;
        target.tokens.cacheRead += row.tokens.cacheRead;
        target.tokens.cacheWrite += row.tokens.cacheWrite;
        target.tokens.total += row.tokens.total;
        target.cost += row.cost;
        target.calls += row.calls;
      }
    }
    return { today, month, all };
  }, [filtered, monthKey, todayKey]);

  const modelRows = useMemo(
    () =>
      groupTotals(
        filtered.filter((row) => range === "today" ? row.date === todayKey : row.date >= windowStart),
        (row) => row.model,
      ),
    [filtered, range, todayKey, windowStart],
  );
  const projectRows = useMemo(() => groupTotals(filtered, (row) => row.cwd || "—"), [filtered]);
  const dailyRows = useMemo(
    () =>
      groupTotals(filtered, (row) => row.date)
        .sort((a, b) => b.key.localeCompare(a.key))
        .slice(0, 30),
    [filtered],
  );
  const titleBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of buckets) {
      if (row.title) map.set(row.sessionId, row.title);
    }
    return map;
  }, [buckets]);

  const todaySessionRows = useMemo(
    () => groupTotals(filtered.filter((row) => row.date === todayKey), (row) => row.sessionId || row.cwd),
    [filtered, todayKey],
  );

  return (
    <ConfigPanelShell embedded={embedded} title={t("common.usage")} closeLabel={t("i18n.close")} onClose={onClose}>
      <div className="usage-page">
        {loading && !data ? (
          <div className="usage-empty">{t("usage.scanning")}</div>
        ) : error ? (
          <div className="usage-empty is-error">{error}</div>
        ) : (
          <>
            <div className="usage-filters">
              <label className="usage-filter">
                <span>{t("usage.project")}</span>
                <select className="usage-select" value={project} onChange={(event) => setProject(event.target.value)}>
                  <option value="all">{t("usage.allProjects")}</option>
                  {projectOptions.map((option) => (
                    <option key={option} value={option}>
                      {projectLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="usage-filter">
                <span>{t("usage.model")}</span>
                <select className="usage-select" value={model} onChange={(event) => setModel(event.target.value)}>
                  <option value="all">{t("usage.allModels")}</option>
                  {modelOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <span className="usage-section-note">{t("usage.files", { count: formatCount(data?.files ?? 0) })}</span>
            </div>

            <div className="usage-cards">
              <SummaryCard label={t("usage.today")} totals={totals.today} />
              <SummaryCard label={t("usage.month")} totals={totals.month} />
              <SummaryCard label={t("usage.all")} totals={totals.all} />
            </div>

            <section className="usage-section">
              <ConfigSectionTitle>{t("usage.heatmap")}</ConfigSectionTitle>
              <UsageHeatmap rows={groupTotals(filtered, (row) => row.date)} />
            </section>

            <section className="usage-section">
              <div className="usage-section-head">
                <ConfigSectionTitle>{t("usage.byModel")}</ConfigSectionTitle>
                <div className="usage-toggle">
                  <button
                    type="button"
                    className={`usage-toggle-button${range === "today" ? " is-active" : ""}`}
                    onClick={() => setRange("today")}
                  >
                    {t("usage.today")}
                  </button>
                  <button
                    type="button"
                    className={`usage-toggle-button${range === "90d" ? " is-active" : ""}`}
                    onClick={() => setRange("90d")}
                  >
                    {t("usage.range90d")}
                  </button>
                </div>
              </div>
              <TotalsTable
                rows={modelRows}
                firstHeader={t("usage.model")}
                labelOf={(key) => key}
                emptyLabel={t("usage.empty")}
              />
            </section>

            <section className="usage-section">
              <ConfigSectionTitle>{t("usage.byProject")}</ConfigSectionTitle>
              <TotalsTable
                rows={projectRows}
                firstHeader={t("usage.project")}
                labelOf={projectLabel}
                emptyLabel={t("usage.empty")}
              />
            </section>

            <section className="usage-section">
              <ConfigSectionTitle>{t("usage.todaySessions")}</ConfigSectionTitle>
              <TotalsTable
                rows={todaySessionRows}
                firstHeader={t("usage.session")}
                labelOf={(key) => titleBySession.get(key) || (key.length > 8 ? key.slice(0, 8) : key)}
                emptyLabel={t("usage.empty")}
                limit={20}
              />
            </section>

            <section className="usage-section">
              <ConfigSectionTitle>{t("usage.history")}</ConfigSectionTitle>
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>{t("usage.date")}</th>
                    <th className="num">{t("usage.calls")}</th>
                    <th className="num">{t("usage.input")}</th>
                    <th className="num">{t("usage.cache")}</th>
                    <th className="num">{t("usage.output")}</th>
                    <th className="num">{t("usage.cost")}</th>
                  </tr>
                </thead>
                <tbody>
                  {dailyRows.map((row) => (
                    <tr key={row.key}>
                      <td>{row.key}</td>
                      <td className="num">{formatCount(row.totals.calls)}</td>
                      <td className="num">{formatTokens(row.totals.tokens.input)}</td>
                      <td className="num">{formatTokens(row.totals.tokens.cacheRead)}</td>
                      <td className="num">{formatTokens(row.totals.tokens.output)}</td>
                      <td className="num">{formatMoney(row.totals.cost)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {dailyRows.length === 0 && <div className="usage-empty">{t("usage.empty")}</div>}
            </section>
          </>
        )}
      </div>
    </ConfigPanelShell>
  );
}
