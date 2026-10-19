"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { parseJsonlRecords, recordSummary } from "@/lib/jsonl-records";

interface Props {
  content: string;
  /** The whole file is loaded; a truncated one still shows its prefix, marked. */
  complete: boolean;
}

/**
 * A `.jsonl` file's records: one collapsible card per line, the summary in the
 * header and the indented JSON when open.
 */
export function JsonlRecords({ content, complete }: Props) {
  const { t } = useI18n();
  const { records, truncated } = useMemo(() => parseJsonlRecords(content), [content]);
  const [openLines, setOpenLines] = useState<Set<number>>(new Set());

  const toggle = (line: number) => {
    setOpenLines((previous) => {
      const next = new Set(previous);
      if (next.has(line)) next.delete(line); else next.add(line);
      return next;
    });
  };

  if (records.length === 0) {
    return (
      <div style={{ padding: 24, color: "var(--text-dim)", fontSize: 12 }}>
        {t("files.noRecords")}
      </div>
    );
  }

  return (
    <div className="jsonl-records" style={{ padding: "8px 12px 16px" }}>
      {records.map((record) => {
        const open = openLines.has(record.line);
        return (
          <div
            key={record.line}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 6,
              marginBottom: 4,
              background: "var(--bg-panel)",
            }}
          >
            <button
              type="button"
              onClick={() => toggle(record.line)}
              aria-expanded={open}
              title={record.error ?? record.text}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                width: "100%",
                boxSizing: "border-box",
                padding: "4px 8px",
                border: "none",
                borderRadius: 6,
                background: "none",
                color: "inherit",
                cursor: "pointer",
                textAlign: "left",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
              }}
              onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; }}
            >
              <span style={{ color: "var(--text-dim)", minWidth: 40, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                {record.line}
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: record.error ? "#f87171" : "var(--text)",
                }}
              >
                {record.error ?? recordSummary(record.value)}
              </span>
              <span aria-hidden="true" style={{ color: "var(--text-dim)" }}>{open ? "▾" : "▸"}</span>
            </button>
            {open && (
              <pre
                style={{
                  margin: 0,
                  padding: "6px 10px 8px 56px",
                  overflow: "auto",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: "var(--text-muted)",
                  borderTop: "1px solid var(--border)",
                }}
              >
                {record.error ?? JSON.stringify(record.value, null, 2)}
              </pre>
            )}
          </div>
        );
      })}
      {truncated && (
        <div style={{ padding: "4px 2px", fontSize: 10, color: "var(--text-dim)" }}>
          {t("files.recordsTruncated")}
        </div>
      )}
      {!complete && (
        <div style={{ padding: "4px 2px", fontSize: 10, color: "var(--text-dim)" }}>
          {t("files.recordsPartial")}
        </div>
      )}
    </div>
  );
}
