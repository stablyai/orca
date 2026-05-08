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
  return (
    <div className="relative space-y-4 rounded-2xl border border-border p-5">
      <div className="grid gap-3 md:grid-cols-2">
        <button
          className="group flex flex-col rounded-xl border border-foreground/30 bg-muted/50 p-5 text-left transition hover:border-foreground/50 hover:bg-muted"
          disabled={Boolean(busyLabel)}
          onClick={onOpenFolder}
        >
          <div className="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <FolderOpen className="size-5" />
          </div>
          <div className="mt-4 text-base font-semibold text-foreground">Open a folder</div>
          <div className="mt-1 text-[13px] text-muted-foreground">
            Choose any local directory — git repo or not.
          </div>
        </button>

        <div className="flex flex-col rounded-xl border border-border bg-muted/30 p-5">
          <div className="grid size-10 place-items-center rounded-lg bg-muted text-foreground">
            <GitBranch className="size-5" />
          </div>
          <div className="mt-4 text-base font-semibold text-foreground">Clone a repo</div>
          <div className="mt-1 text-[13px] text-muted-foreground">Paste an HTTPS or SSH URL.</div>
          <div className="mt-3 flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-foreground/40 focus:ring-1 focus:ring-foreground/20"
              placeholder="git@github.com:org/repo.git"
              value={cloneUrl}
              disabled={Boolean(busyLabel)}
              onChange={(event) => onCloneUrlChange(event.target.value)}
            />
            <button
              className="shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              disabled={!cloneUrl.trim() || Boolean(busyLabel)}
              onClick={onClone}
            >
              Clone
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-xs">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span>Workspace</span>
          <span className="truncate font-mono text-foreground">{workspaceDir}</span>
        </div>
        <div className="flex items-center gap-1.5 text-muted-foreground">
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
