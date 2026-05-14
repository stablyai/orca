import { FolderOpen, GitBranch, Server } from 'lucide-react'

type RepoStepProps = {
  cloneUrl: string
  onCloneUrlChange: (value: string) => void
  onOpenFolder: () => void
  onClone: () => void
  workspaceDir: string
  busyLabel: string | null
  error: string | null
}

export function RepoStep({
  cloneUrl,
  onCloneUrlChange,
  onOpenFolder,
  onClone,
  workspaceDir,
  busyLabel,
  error
}: RepoStepProps) {
  const disabled = Boolean(busyLabel)
  return (
    <div className="space-y-3">
      <button
        type="button"
        className="group flex w-full items-center gap-4 rounded-xl border border-border bg-muted/30 p-5 text-left transition hover:border-foreground/40 hover:bg-muted/60 disabled:opacity-60"
        disabled={disabled}
        onClick={onOpenFolder}
      >
        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
          <FolderOpen className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-foreground">Open a folder</div>
          <div className="mt-0.5 text-[13px] text-muted-foreground">
            Choose any local directory, git repo or not.
          </div>
        </div>
        <span className="shrink-0 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition group-hover:border-foreground/40">
          Browse…
        </span>
      </button>

      <form
        className="rounded-xl border border-border bg-muted/30 p-5"
        onSubmit={(e) => {
          e.preventDefault()
          onClone()
        }}
      >
        <div className="flex items-center gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
            <GitBranch className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold text-foreground">Clone a repo</div>
            <div className="mt-0.5 text-[13px] text-muted-foreground">
              Paste an HTTPS or SSH URL.
            </div>
          </div>
        </div>
        <div className="mt-4 flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
            placeholder="git@github.com:org/repo.git"
            value={cloneUrl}
            disabled={disabled}
            onChange={(event) => onCloneUrlChange(event.target.value)}
          />
          <button
            type="submit"
            className="shrink-0 rounded-lg bg-primary px-5 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            disabled={!cloneUrl.trim() || disabled}
          >
            Clone
          </button>
        </div>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span>Workspace</span>
          <span className="truncate font-mono text-foreground">{workspaceDir}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Server className="size-3.5" />
          <span>SSH? Set hosts up in Settings</span>
        </div>
      </div>

      {busyLabel && (
        <div className="rounded-lg border border-blue-400/30 bg-blue-400/10 px-4 py-2.5 text-sm text-blue-700 dark:text-blue-200">
          {busyLabel}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm text-red-700 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  )
}
