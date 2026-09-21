import { Loader2 } from 'lucide-react'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { CheckButton, SortIndicator } from './workspace-space-selection-controls'
import { WorkspaceSpaceWorktreeRow } from './workspace-space-worktree-row'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import type { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerTable({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  const {
    analysis,
    decisionDetailsByWorktreeId,
    deleteWorktrees,
    forceDeleteWorktree,
    gitRefreshStateByWorktreeId,
    hasRows,
    inspectedWorktree,
    isInitialScan,
    maxSize,
    nextSelectedIds,
    getDeleteStateForWorktree,
    rows,
    scanError,
    setInspectedWorktreeId,
    sortDirection,
    sortKey,
    toggleSelection,
    toggleSort,
    toggleVisibleSelection,
    visibleDeletableIds,
    visibleSelectionState,
    allVisibleSelected
  } = model
  return (
    <>
      {hasRows || isInitialScan ? (
        <div className="overflow-x-auto rounded-lg border border-border/70 bg-background/30">
          <div className="min-w-[46rem]">
            <div className="grid grid-cols-[1.75rem_minmax(0,1.25fr)_minmax(9rem,0.55fr)_8rem_9.5rem] gap-3 border-b border-border/60 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <div className="flex items-center">
                <CheckButton
                  checked={visibleSelectionState}
                  disabled={visibleDeletableIds.length === 0}
                  label={
                    allVisibleSelected
                      ? translate(
                          'auto.components.status.bar.WorkspaceSpaceManagerPanel.697d60c456',
                          'Clear visible selection'
                        )
                      : translate(
                          'auto.components.status.bar.WorkspaceSpaceManagerPanel.1d0f8300d1',
                          'Select visible deletable workspaces'
                        )
                  }
                  onClick={toggleVisibleSelection}
                />
              </div>
              <button
                type="button"
                onClick={() => toggleSort('name')}
                className="flex items-center gap-1 text-left"
              >
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.e4aebea158',
                  'Workspace'
                )}
                <SortIndicator sortKey="name" activeKey={sortKey} direction={sortDirection} />
              </button>
              <button
                type="button"
                onClick={() => toggleSort('repo')}
                className="flex items-center gap-1 text-left"
              >
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.81f14d9924',
                  'Repository'
                )}
                <SortIndicator sortKey="repo" activeKey={sortKey} direction={sortDirection} />
              </button>
              <button
                type="button"
                onClick={() => toggleSort('size')}
                className="flex items-center justify-end gap-1 text-right"
              >
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.33aef3e9cc',
                  'Size'
                )}
                <SortIndicator sortKey="size" activeKey={sortKey} direction={sortDirection} />
              </button>
              <div className="text-right">
                {translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.be37293b10',
                  'State'
                )}
              </div>
            </div>

            <div className="max-h-[28rem] overflow-y-auto scrollbar-sleek">
              {isInitialScan ? (
                <div className="flex items-center justify-center gap-2 px-4 py-10 text-center text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.a02d84d2d2',
                    'Scanning workspaces. You can leave this page.'
                  )}
                </div>
              ) : rows.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {translate(
                    'auto.components.status.bar.WorkspaceSpaceManagerPanel.e031e93219',
                    'No matching workspaces.'
                  )}
                </div>
              ) : (
                rows.map((worktree) => {
                  const identity = getWorkspaceSpaceWorktreeIdentity(worktree)
                  const decisionDetails = decisionDetailsByWorktreeId.get(identity)
                  if (!decisionDetails) {
                    return null
                  }
                  return (
                    <WorkspaceSpaceWorktreeRow
                      key={identity}
                      worktree={worktree}
                      maxSize={maxSize}
                      selected={nextSelectedIds.has(identity)}
                      inspected={
                        inspectedWorktree !== null &&
                        getWorkspaceSpaceWorktreeIdentity(inspectedWorktree) === identity
                      }
                      decisionDetails={decisionDetails}
                      gitRefreshState={gitRefreshStateByWorktreeId[identity]}
                      deleteState={getDeleteStateForWorktree(worktree)}
                      onToggleSelected={() => toggleSelection(worktree)}
                      onInspect={() => setInspectedWorktreeId(identity)}
                      onOpenWorkspace={() => activateAndRevealWorktree(worktree.worktreeId)}
                      onDelete={() => deleteWorktrees([worktree])}
                      onForceDelete={() => forceDeleteWorktree(worktree)}
                    />
                  )
                })
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border/70 bg-background/30 px-4 py-10 text-center text-sm text-muted-foreground">
          {scanError
            ? translate(
                'auto.components.status.bar.WorkspaceSpaceManagerPanel.8194a4fb29',
                'Scan failed before any workspace sizes were collected.'
              )
            : analysis
              ? translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.61e25239da',
                  'No workspace rows were available from the scan.'
                )
              : translate(
                  'auto.components.status.bar.WorkspaceSpaceManagerPanel.e91dd2a9ae',
                  'Run a scan to inspect workspace sizes.'
                )}
        </div>
      )}
    </>
  )
}
