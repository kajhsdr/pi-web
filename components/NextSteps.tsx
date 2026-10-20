"use client";

import { useI18n } from "@/hooks/useI18n";

/**
 * The next-step chips (#1341): the last settled run's suggestions, drawn as
 * pills above the composer. Clicking one sends it as the next user message —
 * the whole point is that resuming costs one click, not retyping.
 *
 * Rendering only: the wrapper generates the suggestions (lib/rpc-manager.ts)
 * and clears them when the next prompt is accepted.
 */
export function NextSteps({
  steps,
  onSend,
  disabled = false,
}: {
  steps: string[];
  onSend: (message: string) => void;
  /** While a run is in flight the chips stay visible but cannot be sent. */
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (steps.length === 0) return null;

  return (
    <div className="next-steps" role="group" aria-label={t("chat.nextSteps")}>
      {steps.map((step) => (
        <button
          key={step}
          type="button"
          className="next-step-chip"
          disabled={disabled}
          title={step}
          onClick={() => onSend(step)}
        >
          <span className="next-step-text">{step}</span>
          <svg className="next-step-send" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M13 3v5a3 3 0 0 1-3 3H4" />
            <path d="M6.5 8.5 4 11l2.5 2.5" />
          </svg>
        </button>
      ))}
    </div>
  );
}
