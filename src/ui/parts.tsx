// Small presentational pieces shared by the panel and dialogs. Colors come
// from host theme tokens only.
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "warning" | "danger" | "info"; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium leading-none",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "warning" && "border border-warning/20 bg-warning/5 text-warning-text",
        tone === "danger" && "bg-destructive/15 text-destructive",
        tone === "info" && "bg-primary/10 text-primary",
      )}
    >
      {children}
    </span>
  );
}

/** Text with `backticked` spans shown as code. */
export function CodeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/u).map((part, index) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={index} className="rounded bg-muted px-1 font-mono text-[0.95em]">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function Notice({ tone = "info", icon, children }: { tone?: "info" | "warning" | "danger"; icon?: string; children: ReactNode }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed",
        tone === "info" && "border-border bg-muted/40 text-muted-foreground",
        tone === "warning" && "border-warning/20 bg-warning/5 text-foreground",
        tone === "danger" && "border-destructive/50 bg-destructive/10 text-foreground",
      )}
    >
      <Icon
        name={icon ?? (tone === "info" ? "Info" : "AlertTriangle")}
        className={cn("mt-0.5 size-3.5 shrink-0", tone === "warning" && "text-warning", tone === "danger" && "text-destructive")}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <Icon name="Loading" className="size-3.5 animate-spin" aria-hidden />
      {label}
    </span>
  );
}

export function Counts({ additions, deletions, binary }: { additions: number | null; deletions: number | null; binary?: boolean }) {
  if (binary) return <span className="font-mono text-[11px] text-muted-foreground">binary</span>;
  return (
    <span className="font-mono text-[11px] tabular-nums">
      <span className="text-diff-added">+{additions ?? 0}</span>{" "}
      <span className="text-diff-removed">−{deletions ?? 0}</span>
    </span>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{children}</h3>
      {aside}
    </div>
  );
}
