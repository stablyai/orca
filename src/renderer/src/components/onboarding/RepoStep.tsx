import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  FolderTree,
  GitBranch,
  Lightbulb,
  Server
} from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { NestedRepoTreePreview } from '@/components/repo/NestedRepoTreePreview'
import type { NestedRepoScanResult } from '../../../../shared/types'

type RepoStepProps = {
  cloneUrl: string
  onCloneUrlChange: (value: string) => void
  nestedScan: NestedRepoScanResult | null
  nestedSelectedPaths: Set<string>
  onNestedSelectedPathsChange: Dispatch<SetStateAction<Set<string>>>
  nestedGroupName: string
  onNestedGroupNameChange: (value: string) => void
  onImportNested: (mode: 'group' | 'separate') => void
  onCancelNested: () => void
  onOpenFolder: () => void
  onOpenServerFolder: (kind: 'git' | 'folder') => void
  onClone: () => void
  onOpenSshSettings: () => void
  serverPath: string
  onServerPathChange: (value: string) => void
  cloneDestination: string
  onCloneDestinationChange: (value: string) => void
  workspaceDir: string
  runtimeActive: boolean
  busyLabel: string | null
  error: string | null
}

export function RepoStep({
  cloneUrl,
  onCloneUrlChange,
  nestedScan,
  nestedSelectedPaths,
  onNestedSelectedPathsChange,
  nestedGroupName,
  onNestedGroupNameChange,
  onImportNested,
  onCancelNested,
  onOpenFolder,
  onOpenServerFolder,
  onClone,
  onOpenSshSettings,
  serverPath,
  onServerPathChange,
  cloneDestination,
  onCloneDestinationChange,
  workspaceDir,
  runtimeActive,
  busyLabel,
  error
}: RepoStepProps) {
  const disabled = Boolean(busyLabel)
  if (nestedScan) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-muted/30 p-5">
          <div className="flex items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <FolderTree className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-foreground">Import as project group</div>
              <div className="mt-0.5 truncate text-[13px] text-muted-foreground">
                {`Found ${nestedScan.repos.length} git ${
                  nestedScan.repos.length === 1 ? 'repository' : 'repositories'
                } in this folder.`}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {nestedScan.selectedPath}
              </div>
            </div>
          </div>
          <div className="mt-4 space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Group name</label>
            <input
              className="w-full rounded-lg border border-border bg-background px-4 py-3 text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
              value={nestedGroupName}
              disabled={disabled}
              onChange={(event) => onNestedGroupNameChange(event.target.value)}
            />
          </div>
          <div className="mt-3">
            <NestedRepoTreePreview
              scan={nestedScan}
              selectedPaths={nestedSelectedPaths}
              onSelectedPathsChange={onNestedSelectedPathsChange}
              disabled={disabled}
            />
          </div>
          {nestedScan.truncated || nestedScan.timedOut ? (
            <div className="mt-2 text-[11px] text-muted-foreground">
              Showing partial results from a bounded scan.
            </div>
          ) : null}
          <div className="mt-4 flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-3 py-3 text-sm text-muted-foreground hover:bg-muted/60 hover:text-foreground disabled:opacity-40"
              disabled={disabled}
              onClick={onCancelNested}
            >
              <ArrowLeft className="size-3.5" />
              Back
            </button>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-40"
                disabled={disabled || nestedSelectedPaths.size === 0}
                onClick={() => onImportNested('separate')}
              >
                Import separately
              </button>
              <button
                type="button"
                className="rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
                disabled={disabled || nestedSelectedPaths.size === 0 || !nestedGroupName.trim()}
                onClick={() => onImportNested('group')}
              >
                Import as project group
              </button>
            </div>
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
  return (
    <div className="space-y-3">
      {runtimeActive ? (
        <form
          className="rounded-lg border border-border bg-muted/30 p-5"
          onSubmit={(event) => {
            event.preventDefault()
            onOpenServerFolder('git')
          }}
        >
          <div className="flex items-center gap-4">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-foreground">
              <FolderOpen className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-base font-semibold text-foreground">Open a server project</div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">
                Enter a path that exists on the runtime server.
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              className="min-w-0 flex-1 rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
              placeholder="/home/user/project"
              value={serverPath}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onServerPathChange(event.target.value)}
            />
            <button
              type="submit"
              className="shrink-0 rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              disabled={!serverPath.trim() || disabled}
            >
              Add Git Project
            </button>
            <button
              type="button"
              className="shrink-0 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground hover:bg-muted/60 disabled:opacity-40"
              disabled={!serverPath.trim() || disabled}
              onClick={() => onOpenServerFolder('folder')}
            >
              Open as Folder
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="group w-full rounded-xl border border-border bg-muted/30 p-5 text-left transition hover:border-foreground/40 hover:bg-muted/60 disabled:opacity-60"
          disabled={disabled}
          onClick={onOpenFolder}
        >
          <div className="flex items-center gap-4">
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
              Browse...
            </span>
          </div>
          <div className="ml-[3.75rem] mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-muted-foreground">
            <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
              <Lightbulb className="size-3.5" />
            </span>
            <span>Want to import many repos at once? Select the parent folder.</span>
          </div>
        </button>
      )}

      <form
        className="rounded-lg border border-border bg-muted/30 p-5"
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
            disabled={!cloneUrl.trim() || (runtimeActive && !cloneDestination.trim()) || disabled}
          >
            Clone
          </button>
        </div>
        {runtimeActive && (
          <div className="mt-2 space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Clone into server path
            </label>
            <input
              className="w-full rounded-lg border border-border bg-background px-4 py-3 font-mono text-sm text-foreground outline-none transition focus:border-foreground/50 focus:ring-2 focus:ring-foreground/15"
              placeholder="/home/user"
              value={cloneDestination}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onCloneDestinationChange(event.target.value)}
            />
          </div>
        )}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-1 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2">
          <span>Workspace</span>
          <span className="truncate font-mono text-foreground">
            {runtimeActive ? 'Runtime server' : workspaceDir}
          </span>
        </div>
        {runtimeActive ? (
          <div className="flex items-center gap-1.5">
            <Server className="size-3.5" />
            <span>Server paths only</span>
          </div>
        ) : (
          <button
            type="button"
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
            disabled={disabled}
            onClick={onOpenSshSettings}
          >
            <Server className="size-3.5 shrink-0" />
            <span className="truncate">SSH? Set hosts up in Settings</span>
            <ArrowRight className="size-3.5 shrink-0" />
          </button>
        )}
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
