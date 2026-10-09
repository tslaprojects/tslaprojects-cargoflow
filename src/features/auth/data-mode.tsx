"use client";
import { Database, FlaskConical } from "lucide-react";
import * as React from "react";
import { ConfirmDialog } from "@/components/common/confirm-dialog";
import { api, errorMessage } from "@/lib/client/api";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

export type DataModeValue = "real" | "demo";

export const DATA_MODE_META: Record<DataModeValue, { label: string; short: string; hint: string; icon: typeof Database }> = {
  demo: { label: "Демо-база", short: "Демо", hint: "тестовые данные, можно экспериментировать", icon: FlaskConical },
  real: { label: "Реальная база", short: "Реальная", hint: "рабочие данные компании", icon: Database },
};

/** Выбор режима данных на странице входа (радиогруппа: доступна с клавиатуры и для скринридеров). */
export function DataModeSelector({ value, onChange }: { value: DataModeValue; onChange: (v: DataModeValue) => void }) {
  return (
    <fieldset>
      <legend className="text-sm leading-none font-medium">Режим данных</legend>
      <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Режим данных">
        {(["demo", "real"] as const).map((mode) => {
          const meta = DATA_MODE_META[mode];
          const Icon = meta.icon;
          const checked = value === mode;
          return (
            <label
              key={mode}
              className={cn(
                "border-border-strong bg-card has-[:focus-visible]:outline-ring relative flex min-h-16 cursor-pointer items-start gap-2.5 rounded-lg border p-3 transition-[border-color,box-shadow,background-color] duration-150 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2",
                checked
                  ? mode === "demo"
                    ? "border-warning bg-warning-bg ring-warning/15 ring-4"
                    : "border-primary bg-accent ring-primary/15 ring-4"
                  : "hover:border-input",
              )}
              data-testid={`data-mode-${mode}`}
            >
              <input type="radio" name="dataMode" value={mode} checked={checked} onChange={() => onChange(mode)} className="sr-only" />
              <span
                className={cn(
                  "grid size-8 shrink-0 place-items-center rounded-md",
                  checked ? (mode === "demo" ? "bg-card text-warning" : "bg-card text-primary") : "bg-muted text-muted-foreground",
                )}
                aria-hidden
              >
                <Icon className="size-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{meta.label}</span>
                <span className="text-muted-foreground block text-xs leading-4">{meta.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Индикатор текущего режима в шапке: всегда виден, демо выделено предупреждающим цветом. */
export function DataModeBadge({ mode, className }: { mode: DataModeValue; className?: string }) {
  const meta = DATA_MODE_META[mode];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold whitespace-nowrap",
        mode === "demo" ? "border-warning-border bg-warning-bg text-warning" : "border-info-border bg-info-bg text-info",
        className,
      )}
      data-testid="data-mode-badge"
      data-mode={mode}
      title={`Режим данных: ${meta.label}`}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="sm:hidden">{meta.short}</span>
      <span className="hidden sm:inline">{meta.label}</span>
    </span>
  );
}

/**
 * Переключение режима после входа: сервер создаёт новую сессию; затем полная перезагрузка —
 * в браузере не остаётся данных прежнего режима (кеш маршрутизатора, состояние страниц).
 */
export function DataModeSwitchDialog({
  current,
  open,
  onOpenChange,
}: {
  current: DataModeValue;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const target: DataModeValue = current === "demo" ? "real" : "demo";
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Перейти в режим «${DATA_MODE_META[target].label}»?`}
      description={
        target === "real"
          ? "Вы будете работать с реальными данными компании: все действия влияют на настоящие перевозки и документы."
          : "Вы перейдёте в демо-базу: тестовые данные, которые не затрагивают реальные перевозки."
      }
      consequences={["Учётная запись и права останутся прежними.", "Приложение перезагрузится с данными выбранного режима."]}
      confirmLabel={`Перейти: ${DATA_MODE_META[target].short}`}
      pendingLabel="Переключаем..."
      onConfirm={async () => {
        try {
          const res = await api<{ redirectTo: string }>("/api/auth/data-mode", { body: { dataMode: target } });
          window.location.assign(res.redirectTo);
          return true;
        } catch (e) {
          toast.error(errorMessage(e));
          return false;
        }
      }}
    />
  );
}

const STORAGE_KEY = "cf:last-data-mode";
const listeners = new Set<() => void>();

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function readSaved(): DataModeValue | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "demo" || v === "real" ? v : null;
  } catch {
    return null;
  }
}

/** Последний выбранный режим входа (удобство; на сервере не используется, режим всегда проверяется сервером). */
export function useRememberedDataMode(initial: DataModeValue): [DataModeValue, (m: DataModeValue) => void] {
  const saved = React.useSyncExternalStore(subscribe, readSaved, () => null);
  // Если хранилище недоступно (приватный режим), выбор живёт в состоянии компонента
  const [override, setOverride] = React.useState<DataModeValue | null>(null);
  const update = (m: DataModeValue) => {
    setOverride(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      /* без запоминания */
    }
    listeners.forEach((l) => l());
  };
  return [override ?? saved ?? initial, update];
}
