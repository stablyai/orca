import { useCallback, useMemo, useState } from 'react'
import { ChevronsDownUp, ChevronsUpDown, CircleAlert, RefreshCw } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { readIpcErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import { getAttachedWorktreesForFolderWorkspace } from '../folder-workspace-attached-worktrees'
import { SourceControlHeaderIconButton } from '../source-control/panel/header-icon-button'
import { EmptyState } from '../source-control/listing/empty-state'
import { countChangedFiles } from './changed-repo-model'
import { FolderWorkspaceChangesDiscardDialog } from './FolderWorkspaceChangesDiscardDialog'
import { FolderWorkspaceRepoSection } from './FolderWorkspaceRepoSection'
import { useFolderWorkspaceChanges } from './use-folder-workspace-changes'
import { useFolderWorkspaceChangesActions } from './use-folder-workspace-changes-actions'

type FolderWorkspaceChangesPanelProps = {
  isVisible?: boolean
}

export default function FolderWorkspaceChangesPanel({
  isVisible = true
}: FolderWorkspaceChangesPanelProps): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const revealInExplorer = useAppStore((s) => s.revealInExplorer)

  const { folderWorkspace } = useMemo(
    () =>
      getAttachedWorktreesForFolderWorkspace({
        activeWorkspaceKey,
        activeWorktreeId,
        folderWorkspaces,
        workspaceLineageByChildKey,
        worktreeLineageById,
        worktreesByRepo
      }),
    [
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo
    ]
  )
  const folderWorkspaceId = folderWorkspace?.id ?? null
  // Why: the shared host resolver collapses a `runtime:` host to `local`. Reading git at the remote
  // path through local IPC would touch the client's disk, so runtime-hosted folders stay unavailable.
  const isRuntimeHosted = parseExecutionHostId(folderWorkspace?.executionHostId)?.kind === 'runtime'
  const connectionId = useAppStore((s) =>
    folderWorkspaceId && !isRuntimeHosted
      ? getFolderWorkspaceConnectionId(s, folderWorkspaceId)
      : undefined
  )
  // Why: the folder workspace key is the editor's worktree id for tabs opened from this panel.
  const worktreeId = folderWorkspace ? (activeWorktreeId ?? null) : null

  const data = useFolderWorkspaceChanges({
    worktreeId,
    folderWorkspaceId,
    folderPath: folderWorkspace?.folderPath ?? null,
    connectionId,
    isVisible
  })
  const actions = useFolderWorkspaceChangesActions({
    worktreeId,
    connectionId,
    onMutated: data.refreshStatuses
  })

  const [collapsedRepoPaths, setCollapsedRepoPaths] = useState<ReadonlySet<string>>(() => new Set())
  // Why: reset during render so expansion state from another folder never leaks in.
  const [collapsedScopeId, setCollapsedScopeId] = useState(folderWorkspaceId)
  if (collapsedScopeId !== folderWorkspaceId) {
    setCollapsedScopeId(folderWorkspaceId)
    setCollapsedRepoPaths(new Set())
  }
  const toggleRepo = useCallback((repoPath: string): void => {
    setCollapsedRepoPaths((current) => {
      const next = new Set(current)
      if (next.has(repoPath)) {
        next.delete(repoPath)
      } else {
        next.add(repoPath)
      }
      return next
    })
  }, [])
  const expandAll = useCallback((): void => setCollapsedRepoPaths(new Set()), [])
  const collapseAll = useCallback((): void => {
    setCollapsedRepoPaths(new Set(data.changedRepos.map((repo) => repo.path)))
  }, [data.changedRepos])

  if (!folderWorkspace || !worktreeId) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.FolderWorkspaceChangesPanel.unavailable',
          'Workspace changes are only shown for folder workspaces.'
        )}
      </div>
    )
  }

  const changedFileCount = countChangedFiles(data.changedRepos)
  const summary =
    data.changedRepos.length > 0
      ? translate(
          'auto.components.rightSidebar.FolderWorkspaceChangesPanel.summary',
          '{{value0}} of {{value1}} repos · {{value2}} files',
          {
            value0: data.changedRepos.length,
            value1: data.candidates.length,
            value2: changedFileCount
          }
        )
      : null
  const hasRepos = data.changedRepos.length > 0
  // Why: the set keeps paths of repos that became clean, so button state must come from visible repos.
  const hasCollapsedRepo = data.changedRepos.some((repo) => collapsedRepoPaths.has(repo.path))
  const areAllReposCollapsed = data.changedRepos.every((repo) => collapsedRepoPaths.has(repo.path))
  const refreshLabel = translate(
    'auto.components.rightSidebar.FolderWorkspaceChangesPanel.refresh',
    'Refresh workspace changes'
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-foreground">
              {translate(
                'auto.components.rightSidebar.FolderWorkspaceChangesPanel.title',
                'Workspace changes'
              )}
            </div>
            {summary ? (
              <div className="mt-1 truncate text-xs text-muted-foreground">{summary}</div>
            ) : null}
          </div>
          <SourceControlHeaderIconButton
            icon={ChevronsUpDown}
            label={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.expandAll',
              'Expand all repos'
            )}
            onClick={expandAll}
            disabled={!hasCollapsedRepo}
          />
          <SourceControlHeaderIconButton
            icon={ChevronsDownUp}
            label={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.collapseAll',
              'Collapse all repos'
            )}
            onClick={collapseAll}
            disabled={!hasRepos || areAllReposCollapsed}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                onClick={data.refresh}
                disabled={data.isLoading || connectionId === undefined}
                aria-label={refreshLabel}
              >
                <RefreshCw className={cn('size-3.5', data.isLoading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {refreshLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto pb-2">
        {connectionId === undefined ? (
          <EmptyState
            heading={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.hostUnavailableTitle',
              'Folder host unavailable'
            )}
            supportingText={
              isRuntimeHosted
                ? translate(
                    'auto.components.rightSidebar.FolderWorkspaceChangesPanel.runtimeHostUnsupportedCopy',
                    'Workspace changes are not available for folders on a runtime environment yet.'
                  )
                : translate(
                    'auto.components.rightSidebar.FolderWorkspaceChangesPanel.hostUnavailableCopy',
                    'Orca cannot tell which host owns this folder, so git status is not read.'
                  )
            }
          />
        ) : data.scanState === 'error' ? (
          <EmptyState
            heading={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.scanFailedTitle',
              'Could not scan this folder'
            )}
            supportingText={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.scanFailedCopy',
              'Refresh to try again.'
            )}
          />
        ) : data.scanState === 'ready' && data.candidates.length === 0 ? (
          <EmptyState
            heading={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.noReposTitle',
              'No git repositories found'
            )}
            supportingText={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.noReposCopy',
              'Only repositories directly inside this folder are scanned.'
            )}
          />
        ) : !hasRepos &&
          !data.isLoading &&
          data.failedRepos.length === 0 &&
          data.incompleteScanRepoCap === null ? (
          <EmptyState
            heading={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.noChangesTitle',
              'No changes'
            )}
            supportingText={translate(
              'auto.components.rightSidebar.FolderWorkspaceChangesPanel.noChangesCopy',
              'Edited files appear here as you save them.'
            )}
          />
        ) : (
          <>
            {data.incompleteScanRepoCap !== null ? (
              <div className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <span>
                  {translate(
                    'auto.components.rightSidebar.FolderWorkspaceChangesPanel.scanRepoCapCopy',
                    'Only the first {{value0}} repositories in this folder are scanned. Repositories beyond that are not shown.',
                    { value0: data.incompleteScanRepoCap }
                  )}
                </span>
              </div>
            ) : null}
            {data.changedRepos.map((repo) => (
              <FolderWorkspaceRepoSection
                key={repo.path}
                repo={repo}
                worktreeId={worktreeId}
                connectionId={connectionId}
                isCollapsed={collapsedRepoPaths.has(repo.path)}
                isExecutingDiscard={actions.isExecutingDiscard}
                onToggle={() => toggleRepo(repo.path)}
                onOpenEntry={(entry, event) => actions.openEntry(repo, entry, event)}
                onStage={(filePath) => actions.stageEntry(repo, filePath)}
                onUnstage={(filePath) => actions.unstageEntry(repo, filePath)}
                onDiscardEntry={(entry) => actions.requestDiscardEntry(repo, entry)}
                onDiscardRepo={() => actions.requestDiscardRepo(repo)}
                onRevealInExplorer={revealInExplorer}
              />
            ))}
            {data.failedRepos.map((repo) => (
              <div
                key={repo.path}
                className="mx-3 mt-2 flex items-start gap-2 rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs"
                title={repo.path}
              >
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <div className="truncate font-medium text-foreground">{repo.name}</div>
                  <div className="break-words text-muted-foreground">
                    {readIpcErrorMessage(repo.error) ??
                      translate(
                        'auto.components.rightSidebar.FolderWorkspaceChangesPanel.statusFailed',
                        'Could not read git status.'
                      )}
                  </div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <FolderWorkspaceChangesDiscardDialog
        pendingDiscard={actions.pendingDiscard}
        onCancel={actions.cancelPendingDiscard}
        onConfirm={() => void actions.confirmPendingDiscard()}
      />
    </div>
  )
}
