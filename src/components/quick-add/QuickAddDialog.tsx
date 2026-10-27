import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ClipboardPaste, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ProviderIcon } from "@/components/ProviderIcon";
import { toast } from "@/lib/toast";
import { providersApi } from "@/lib/api";
import {
  quickAddApi,
  type DetectResult,
  type PastePreview,
  type ProbeEvent,
} from "@/lib/api/quickAdd";
import { generateUUID } from "@/utils/uuid";
import { cn } from "@/lib/utils";
import {
  appsMissingModel,
  buildQuickAddProviders,
  defaultSelection,
  QUICK_ADD_FILES,
  type QuickAddApp,
  type QuickAddSelection,
} from "./buildProviders";

type Step = "paste" | "probe" | "confirm" | "done";

const APP_LABELS: Record<QuickAddApp, string> = {
  claude: "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
};

const CLAUDE_SLOTS = [
  ["main", "quickAdd.slot.main", "主模型"],
  ["opus", "quickAdd.slot.opus", "Opus"],
  ["sonnet", "quickAdd.slot.sonnet", "Sonnet"],
  ["haiku", "quickAdd.slot.haiku", "Haiku"],
] as const;

export interface QuickAddDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时预填的内容（例如全局粘贴） */
  initialText?: string;
}

export function QuickAddDialog({
  open,
  onOpenChange,
  initialText,
}: QuickAddDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<PastePreview | null>(null);
  const [events, setEvents] = useState<Record<string, ProbeEvent>>({});
  const [result, setResult] = useState<DetectResult | null>(null);
  const [selection, setSelection] = useState<QuickAddSelection | null>(null);
  const [activate, setActivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<QuickAddApp[]>([]);
  const runId = useRef(0);

  useEffect(() => {
    if (open) {
      setStep("paste");
      setText(initialText ?? "");
      setResult(null);
      setSelection(null);
      setEvents({});
      setError(null);
      setSaved([]);
    } else {
      runId.current += 1;
    }
  }, [open, initialText]);

  // 输入变化时本地预览（不联网）
  useEffect(() => {
    if (!open || !text.trim()) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      quickAddApi
        .preview(text)
        .then((p) => !cancelled && setPreview(p))
        .catch(() => !cancelled && setPreview(null));
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, text]);

  const pasteFromClipboard = useCallback(async () => {
    try {
      const value = await navigator.clipboard.readText();
      if (value) setText(value);
    } catch {
      toast.error(
        t("quickAdd.clipboardFailed", {
          defaultValue: "无法读取剪贴板，请直接在输入框里粘贴",
        }),
      );
    }
  }, [t]);

  const startDetect = useCallback(async () => {
    const id = ++runId.current;
    setError(null);
    setEvents({});
    setStep("probe");
    try {
      const r = await quickAddApi.detect(text, (e) => {
        if (runId.current === id) {
          setEvents((prev) => ({ ...prev, [e.candidateId]: e }));
        }
      });
      if (runId.current !== id) return;
      setResult(r);
      setSelection(defaultSelection(r));
      setStep("confirm");
    } catch (e) {
      if (runId.current !== id) return;
      setError(String(e));
    }
  }, [text]);

  const built = useMemo(
    () =>
      result && selection ? buildQuickAddProviders(result, selection) : [],
    [result, selection],
  );
  const missingModel = selection
    ? appsMissingModel(selection).length > 0
    : false;

  const save = useCallback(async () => {
    if (!built.length) return;
    setSaving(true);
    const done: QuickAddApp[] = [];
    try {
      for (const { app, provider } of built) {
        const id = generateUUID();
        await providersApi.add({ ...provider, id, createdAt: Date.now() }, app);
        if (activate) {
          await providersApi.switch(id, app);
        }
        done.push(app);
        await queryClient.invalidateQueries({ queryKey: ["providers", app] });
      }
      try {
        await providersApi.updateTrayMenu();
      } catch {
        // 托盘刷新失败不影响结果
      }
      setSaved(done);
      setStep("done");
    } catch (e) {
      toast.error(
        t("quickAdd.saveFailed", {
          defaultValue: "保存失败：{{error}}",
          error: String(e),
        }),
      );
      if (done.length) setSaved(done);
    } finally {
      setSaving(false);
    }
  }, [activate, built, queryClient, t]);

  const canDetect =
    Boolean(preview?.keyMasked) && preview!.candidates.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-serif text-[22px] font-medium">
            {t(`quickAdd.title.${step}`, {
              defaultValue: {
                paste: "粘贴你的 Key",
                probe: "正在识别",
                confirm: "确认模型",
                done: "已写入，可以开用了",
              }[step],
            })}
          </DialogTitle>
          <DialogDescription>
            {t("quickAdd.subtitle", {
              defaultValue:
                "支持裸 Key、环境变量、JSON、curl 命令，或「地址 + Key」。带地址时以地址为准。",
            })}
          </DialogDescription>
          <StepDots step={step} />
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-2">
          {step === "paste" && (
            <div className="flex flex-col gap-3">
              <Textarea
                id="quick-add-text"
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="sk-…"
                className="min-h-[110px] font-mono text-[13px]"
                spellCheck={false}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="neutral"
                  size="compact"
                  onClick={pasteFromClipboard}
                >
                  <ClipboardPaste className="h-3.5 w-3.5" />
                  {t("quickAdd.pasteClipboard", {
                    defaultValue: "从剪贴板粘贴",
                  })}
                </Button>
                {preview?.keyMasked && (
                  <span className="font-mono text-xs text-fg-2">
                    Key {preview.keyMasked}
                  </span>
                )}
              </div>
              <PreviewNote preview={preview} hasText={Boolean(text.trim())} />
            </div>
          )}

          {step === "probe" && preview && (
            <div className="flex flex-col gap-1.5">
              {preview.candidates.map((c) => (
                <ProbeRow
                  key={c.id}
                  name={c.name}
                  host={c.host}
                  event={events[c.id]}
                />
              ))}
              {error && (
                <p className="mt-2 rounded-control bg-danger-soft px-3 py-2 text-sm text-danger-text">
                  {error}
                </p>
              )}
            </div>
          )}

          {step === "confirm" && result && selection && (
            <ConfirmView
              result={result}
              selection={selection}
              onChange={setSelection}
              activate={activate}
              onActivateChange={setActivate}
              apps={built.map((b) => b.app)}
            />
          )}

          {step === "done" && (
            <div className="flex flex-col gap-2 py-2">
              {saved.flatMap((app) =>
                QUICK_ADD_FILES[app].map((f) => (
                  <div
                    key={f}
                    className="flex items-center gap-2 font-mono text-xs text-fg-2"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 text-success-text" />
                    {APP_LABELS[app]} · {f}
                  </div>
                )),
              )}
              <p className="pt-2 text-sm text-fg-2">
                {activate
                  ? t("quickAdd.doneActive", {
                      defaultValue:
                        "已启用。打开新的终端窗口运行 claude / codex / gemini 即可使用。",
                    })
                  : t("quickAdd.doneSaved", {
                      defaultValue: "已保存到供应商列表，需要时点「启用」。",
                    })}
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          {step === "paste" && (
            <Button variant="solid" disabled={!canDetect} onClick={startDetect}>
              {t("quickAdd.detect", { defaultValue: "识别并检测" })}
            </Button>
          )}
          {step === "probe" && error && (
            <Button variant="neutral" onClick={() => setStep("paste")}>
              {t("quickAdd.back", { defaultValue: "返回修改" })}
            </Button>
          )}
          {step === "confirm" && (
            <>
              <Button variant="neutral" onClick={() => setStep("paste")}>
                {t("quickAdd.another", { defaultValue: "换一个 Key" })}
              </Button>
              <Button
                variant="solid"
                disabled={!built.length || missingModel || saving}
                onClick={save}
              >
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {activate
                  ? t("quickAdd.saveActivate", { defaultValue: "保存并启用" })
                  : t("quickAdd.saveOnly", { defaultValue: "保存" })}
              </Button>
            </>
          )}
          {step === "done" && (
            <>
              <Button variant="neutral" onClick={() => setStep("paste")}>
                {t("quickAdd.addAnother", { defaultValue: "再添加一个" })}
              </Button>
              <Button variant="solid" onClick={() => onOpenChange(false)}>
                {t("common.done", { defaultValue: "完成" })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StepDots({ step }: { step: Step }) {
  const { t } = useTranslation();
  const steps: Step[] = ["paste", "probe", "confirm", "done"];
  const labels = {
    paste: t("quickAdd.step.paste", { defaultValue: "粘贴" }),
    probe: t("quickAdd.step.probe", { defaultValue: "识别" }),
    confirm: t("quickAdd.step.confirm", { defaultValue: "确认模型" }),
    done: t("quickAdd.step.done", { defaultValue: "完成" }),
  };
  const current = steps.indexOf(step);
  return (
    <ol className="mt-2 flex flex-wrap gap-1.5 text-xs">
      {steps.map((s, i) => (
        <li
          key={s}
          className={cn(
            "rounded-full border px-2.5 py-0.5",
            i <= current
              ? "border-transparent bg-action-soft text-fg-1"
              : "border-border text-fg-3",
          )}
        >
          {i + 1} {labels[s]}
        </li>
      ))}
    </ol>
  );
}

function PreviewNote({
  preview,
  hasText,
}: {
  preview: PastePreview | null;
  hasText: boolean;
}) {
  const { t, i18n } = useTranslation();
  if (!hasText || !preview) return null;
  if (!preview.keyMasked) {
    return (
      <p className="text-sm text-fg-2">
        {t("quickAdd.noKey", { defaultValue: "还没找到 Key。" })}
      </p>
    );
  }
  if (preview.candidates.length === 0) {
    return (
      <p className="text-sm text-warning-text">
        {t("quickAdd.unknownFormat", {
          defaultValue:
            "认不出这个 Key 属于哪家。请在下一行补上接口地址（例如 https://api.example.com/v1）。",
        })}
      </p>
    );
  }
  const sep = /^(zh|ja)/.test(i18n.language) ? "、" : ", ";
  const hosts = preview.candidates.map((c) => c.host).join(sep);
  return (
    <p className="text-sm text-fg-2">
      {preview.baseUrl
        ? t("quickAdd.willUseUrl", {
            defaultValue: "将按你粘贴的地址检测：{{hosts}}",
            hosts,
          })
        : preview.candidates.length === 1
          ? t("quickAdd.willProbeOne", {
              defaultValue: "看起来是 {{name}}，只验证这一家：{{hosts}}",
              name: preview.candidates[0].name,
              hosts,
            })
          : t("quickAdd.willProbeMany", {
              defaultValue:
                "可能属于 {{count}} 家，Key 只会发往这些官方域名：{{hosts}}",
              count: preview.candidates.length,
              hosts,
            })}
    </p>
  );
}

function ProbeRow({
  name,
  host,
  event,
}: {
  name: string;
  host: string;
  event?: ProbeEvent;
}) {
  const { t } = useTranslation();
  const status = event?.status ?? "probing";
  const label = {
    probing: t("quickAdd.status.probing", { defaultValue: "检测中" }),
    hit: t("quickAdd.status.hit", { defaultValue: "命中" }),
    rejected: t("quickAdd.status.rejected", { defaultValue: "不匹配" }),
    error: t("quickAdd.status.error", { defaultValue: "失败" }),
    cancelled: t("quickAdd.status.cancelled", { defaultValue: "已取消" }),
  }[status];
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)_4.5rem_4rem] items-center gap-3 rounded-control bg-subtle px-3 py-2 text-sm">
      <span className="truncate">{name}</span>
      <span
        className="truncate font-mono text-xs text-fg-2"
        title={event?.message}
      >
        {host}
      </span>
      <span
        className={cn(
          "flex items-center gap-1 text-xs font-semibold",
          status === "hit" && "text-success-text",
          (status === "rejected" || status === "error") && "text-danger-text",
          (status === "probing" || status === "cancelled") && "text-fg-3",
        )}
      >
        {status === "probing" && <Loader2 className="h-3 w-3 animate-spin" />}
        {label}
      </span>
      <span className="text-right font-mono text-xs tabular-nums text-fg-3">
        {event?.latencyMs != null ? `${event.latencyMs} ms` : "—"}
      </span>
    </div>
  );
}

function hasSuggestion(result: DetectResult, app: QuickAddApp): boolean {
  return result.suggested[app] != null;
}

function ConfirmView({
  result,
  selection,
  onChange,
  activate,
  onActivateChange,
  apps,
}: {
  result: DetectResult;
  selection: QuickAddSelection;
  onChange: (s: QuickAddSelection) => void;
  activate: boolean;
  onActivateChange: (v: boolean) => void;
  apps: QuickAddApp[];
}) {
  const { t } = useTranslation();
  const listId = "quick-add-models";
  const reason = (app: QuickAddApp) => {
    const plan = result.apps[app];
    if (!plan) {
      return t("quickAdd.unsupported", {
        defaultValue: "该供应商不提供这个应用需要的协议",
      });
    }
    if (plan.needsProxy) {
      return t("quickAdd.needsProxy", {
        defaultValue: "需要开启本地代理做协议转换，默认不勾选",
      });
    }
    return null;
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <ProviderIcon
          icon={result.provider.icon ?? undefined}
          name={result.provider.name}
          size={40}
        />
        <div className="min-w-0">
          <div className="font-semibold">{result.provider.name}</div>
          <div className="truncate font-mono text-xs text-fg-2">
            {result.modelsBaseUrl} · {result.latencyMs} ms ·{" "}
            {t("quickAdd.modelCount", {
              defaultValue: "{{count}} 个对话模型",
              count: result.models.length,
            })}
          </div>
        </div>
      </div>

      <datalist id={listId}>
        {result.models.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <div className="grid gap-3 sm:grid-cols-2">
        {(["claude", "codex", "gemini"] as QuickAddApp[]).map((app) => {
          const sel = selection[app];
          const plan = result.apps[app];
          const note = reason(app);
          const enabled = Boolean(sel?.enabled);
          return (
            <div
              key={app}
              className={cn(
                "flex min-w-0 flex-col gap-2 rounded-panel border border-border p-3",
                !enabled && "opacity-60",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">{APP_LABELS[app]}</span>
                <Switch
                  checked={enabled}
                  disabled={!sel}
                  aria-label={APP_LABELS[app]}
                  onCheckedChange={(v) =>
                    sel &&
                    onChange({ ...selection, [app]: { ...sel, enabled: v } })
                  }
                />
              </div>
              {app === "claude" && selection.claude ? (
                CLAUDE_SLOTS.map(([slot, key, label]) => (
                  <ModelField
                    key={slot}
                    label={t(key, { defaultValue: label })}
                    listId={listId}
                    value={selection.claude!.slots[slot]}
                    onChange={(v) =>
                      onChange({
                        ...selection,
                        claude: {
                          ...selection.claude!,
                          slots: { ...selection.claude!.slots, [slot]: v },
                        },
                      })
                    }
                  />
                ))
              ) : app !== "claude" && sel && "model" in sel ? (
                <ModelField
                  label={t("quickAdd.slot.model", { defaultValue: "模型" })}
                  listId={listId}
                  value={sel.model}
                  onChange={(v) =>
                    onChange({ ...selection, [app]: { ...sel, model: v } })
                  }
                />
              ) : null}
              {plan?.baseUrl && (
                <span className="break-all font-mono text-[11px] text-fg-3">
                  {plan.baseUrl}
                </span>
              )}
              {(note || !sel) && (
                <span className="text-xs text-fg-2">
                  {note ??
                    t("quickAdd.noModels", {
                      defaultValue: "没有适合这个应用的模型",
                    })}
                </span>
              )}
              {sel && !note && !hasSuggestion(result, app) && (
                <span className="text-xs text-fg-2">
                  {t("quickAdd.typeModel", {
                    defaultValue: "没挑出合适的模型，可以手动填写模型名后启用",
                  })}
                </span>
              )}
              {enabled && appsMissingModel(selection).includes(app) && (
                <span className="text-xs text-danger-text">
                  {t("quickAdd.modelRequired", {
                    defaultValue: "请填写模型名",
                  })}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={activate} onCheckedChange={onActivateChange} />
        {t("quickAdd.activate", {
          defaultValue: "保存后立即启用（写入配置文件）",
        })}
      </label>

      <details className="text-sm">
        <summary className="cursor-pointer text-fg-2">
          {t("quickAdd.filesPreview", { defaultValue: "查看将要修改的文件" })}
        </summary>
        <pre className="mt-2 overflow-x-auto rounded-control bg-subtle p-3 font-mono text-xs text-fg-2">
          {apps.length
            ? apps.flatMap((a) => QUICK_ADD_FILES[a]).join("\n")
            : t("quickAdd.noApps", { defaultValue: "未选择应用" })}
          {"\n"}Key {result.keyMasked}
        </pre>
      </details>
    </div>
  );
}

function ModelField({
  label,
  value,
  onChange,
  listId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  listId: string;
}) {
  return (
    <label className="grid grid-cols-[4rem_minmax(0,1fr)] items-center gap-2 text-xs text-fg-2">
      <span>{label}</span>
      <input
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 min-w-0 rounded-control border border-border bg-surface px-2 font-mono text-xs text-fg-1 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        spellCheck={false}
      />
    </label>
  );
}
