import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  getStoredSwatch,
  setSwatch,
  SWATCHES,
  type SwatchId,
} from "@/themes/swatches";

export function SwatchPicker() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState<SwatchId>(getStoredSwatch);

  return (
    <div
      role="radiogroup"
      aria-label={t("settings.swatch.label", { defaultValue: "色卡" })}
      className="grid grid-cols-3 gap-2 sm:grid-cols-6"
    >
      {SWATCHES.map((s) => {
        const selected = s.id === current;
        return (
          <button
            key={s.id}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => {
              setSwatch(s.id);
              setCurrent(s.id);
            }}
            className={cn(
              "flex min-w-0 flex-col gap-1.5 rounded-panel border border-border bg-surface p-1.5 text-left text-caption text-fg-2 transition-colors hover:text-fg-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected &&
                "border-action text-fg-1 ring-1 ring-[var(--action-bg)]",
            )}
          >
            <span className="flex h-7 overflow-hidden rounded-control">
              {[...s.light.slice(0, 2), ...s.dark.slice(0, 2)].map((c, i) => (
                <span key={i} className="flex-1" style={{ background: c }} />
              ))}
            </span>
            <span className="truncate px-0.5">
              {t(s.nameKey, { defaultValue: s.defaultName })}
            </span>
          </button>
        );
      })}
    </div>
  );
}
