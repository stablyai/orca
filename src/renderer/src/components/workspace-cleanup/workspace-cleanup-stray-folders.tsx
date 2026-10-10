import React, { useCallback, useState } from 'react'
import { ChevronDown, Clock3, FolderX, Loader2, Trash2, Unlink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { getRuntimePathBasename } from '../../../../shared/cross-platform-path'
import type {
  WorkspaceCleanupStrayDirectory,
  WorkspaceCleanupStrayDirectoryScan,
  WorkspaceCleanupStrayDirectorySkipReason
} from '../../../../shared/workspace-cleanup-stray-directories'
import { WorkspaceCleanupMetadataChip } from './workspace-cleanup-metadata-chip'
import { WorkspaceCleanupReasonChips } from './workspace-cleanup-reason-chips'
import { formatWorkspaceCleanupRelativeTime } from './workspace-cleanup-relative-time'
import { formatCompactActivityLabel } from './workspace-cleanup-row-labels'

/**
 * Folders in worktree roots that no project registers. Collapsed by default and never part of the
 * workspace selection: each one is reviewed and moved to the OS trash on its own.
 */
export function WorkspaceCleanupStrayFolders({
  scan,
  now
}: {
  scan: WorkspaceCleanupStrayDirectoryScan | undefined
  now: number
}): React.JSX.Element | null {
  const trashStrayDirectory = useAppStore((s) => s.trashWorkspaceCleanupStrayDirectory)
  const mountedRef = useMountedRef()
  const [expanded, setExpanded] = useState(false)
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set())

  const moveToTrash = useCallback(
    (directoryPath: string) => {
      setPendingPaths((current) => new Set([...current, directoryPath]))
      void trashStrayDirectory(directoryPath)
        .then((result) => {
          if (result.ok) {
            toast.success(
              translate('components.workspace.cleanup.strayFolders.movedToTrash', 'Moved to Trash'),
              { description: directoryPath }
            )
            return
          }
          toast.error(
            translate(
              'components.workspace.cleanup.strayFolders.moveFailed',
              'Could not move folder to Trash'
            ),
            { description: result.message }
          )
        })
        .catch((error: unknown) => {
          toast.error(
            translate(
              'components.workspace.cleanup.strayFolders.moveFailed',
              'Could not move folder to Trash'
            ),
            { description: error instanceof Error ? error.message : String(error) }
          )
        })
        .finally(() => {
          if (mountedRef.current) {
            setPendingPaths((current) => {
              const next = new Set(current)
              next.delete(directoryPath)
              return next
            })
          }
        })
    },
    [mountedRef, trashStrayDirectory]
  )

  if (!scan || scan.directories.length === 0) {
    return null
  }
  return (
    <div className="border-b border-border px-5 py-2" data-workspace-cleanup-stray-folders>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FolderX className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="shrink-0 font-medium text-foreground">
          {translate(
            'components.workspace.cleanup.strayFolders.title',
            'Unregistered folders: {{value0}}',
            { value0: scan.directories.length }
          )}
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {translate(
            'components.workspace.cleanup.strayFolders.description',
            'Found in worktree folders, not registered by any project. Review each one.'
          )}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-180'
          )}
          aria-hidden="true"
        />
      </button>
      {expanded ? (
        <>
          <div className="scrollbar-sleek mt-2 max-h-48 overflow-y-auto rounded-md border border-border">
            {scan.directories.map((directory) => (
              <StrayFolderRow
                key={directory.path}
                directory={directory}
                now={now}
                pending={pendingPaths.has(directory.path)}
                onMoveToTrash={moveToTrash}
              />
            ))}
          </div>
          <StrayFolderScanNotes scan={scan} />
        </>
      ) : null}
    </div>
  )
}

function StrayFolderRow({
  directory,
  now,
  pending,
  onMoveToTrash
}: {
  directory: WorkspaceCleanupStrayDirectory
  now: number
  pending: boolean
  onMoveToTrash: (directoryPath: string) => void
}): React.JSX.Element {
  const modifiedLabel = formatWorkspaceCleanupRelativeTime(directory.lastModifiedAt, now)
  return (
    <div className="flex min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-foreground">
          {getRuntimePathBasename(directory.path)}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {directory.path}
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {directory.path}
          </TooltipContent>
        </Tooltip>
      </div>
      <WorkspaceCleanupReasonChips candidate={directory} />
      {directory.gitLink === 'missing-gitdir' ? (
        <WorkspaceCleanupMetadataChip
          icon={Unlink}
          label={translate(
            'components.workspace.cleanup.strayFolders.brokenGitLinkDescription',
            'Its .git file points to a Git folder that no longer exists'
          )}
          value={translate(
            'components.workspace.cleanup.strayFolders.brokenGitLink',
            'Broken link'
          )}
        />
      ) : null}
      <WorkspaceCleanupMetadataChip
        icon={Clock3}
        label={translate(
          'components.workspace.cleanup.strayFolders.lastModified',
          'Last modified {{value0}}',
          { value0: modifiedLabel }
        )}
        value={formatCompactActivityLabel(modifiedLabel)}
      />
      <Button
        variant="ghost"
        size="xs"
        className="shrink-0"
        disabled={pending}
        onClick={() => onMoveToTrash(directory.path)}
      >
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
        {translate('components.workspace.cleanup.strayFolders.moveToTrash', 'Move to Trash')}
      </Button>
    </div>
  )
}

function StrayFolderScanNotes({
  scan
}: {
  scan: WorkspaceCleanupStrayDirectoryScan
}): React.JSX.Element | null {
  const notes = scan.skippedRoots.map(({ reason }) => getSkipNote(reason))
  if (scan.truncated) {
    notes.push(
      translate(
        'components.workspace.cleanup.strayFolders.truncated',
        'Showing the first {{value0}} folders.',
        { value0: scan.directories.length }
      )
    )
  }
  if (notes.length === 0) {
    return null
  }
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
      {notes.map((note) => (
        <div key={note}>{note}</div>
      ))}
    </div>
  )
}

function getSkipNote(reason: WorkspaceCleanupStrayDirectorySkipReason): string {
  switch (reason) {
    case 'remote-host':
      return translate(
        'components.workspace.cleanup.strayFolders.skippedRemote',
        'Worktree folders on remote hosts were not checked.'
      )
    case 'wsl':
      return translate(
        'components.workspace.cleanup.strayFolders.skippedWsl',
        'Worktree folders inside WSL were not checked.'
      )
    case 'holds-projects':
      return translate(
        'components.workspace.cleanup.strayFolders.skippedHoldsProjects',
        'Worktree folders that also contain projects were not checked.'
      )
    case 'unreadable':
      return translate(
        'components.workspace.cleanup.strayFolders.skippedUnreadable',
        'Some worktree folders could not be read.'
      )
  }
}
