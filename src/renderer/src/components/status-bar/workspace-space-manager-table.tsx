import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { VirtualizedList } from '../virtualized-list'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { CheckButton, SortIndicator } from './workspace-space-selection-controls'
import { WorkspaceSpaceWorktreeRow } from './workspace-space-worktree-row'
import { getWorkspaceSpaceWorktreeIdentity } from './workspace-space-delete-selection'
import type { useWorkspaceSpaceManagerPanel } from './use-workspace-space-manager-panel'
import { WORKSPACE_SPACE_TABLE_GRID_CLASS } from './workspace-space-table-layout'

type WorkspaceSpaceManagerModel = ReturnType<typeof useWorkspaceSpaceManagerPanel>

export function WorkspaceSpaceManagerTable({
  model
}: {
  model: WorkspaceSpaceManagerModel
}): React.JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const {
    analysis,
    decisionDetailsByWorktreeId,
    deleteWorktrees,
    forceDeleteWorktree,
    gitRefreshStateByWorktreeId,
    gitStatusByWorktreeIdentity,
    hasRows,
    inspectedWorktree,
    isInitialScan,
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
    <div className="flex min-h-0 flex-1 flex-col">
      {hasRows || isInitialScan ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-auto rounded-lg border border-border/70 bg-background/30">
          <div className="flex min-h-0 min-w-[54rem] flex-1 flex-col">
            <div
              className={cn(
                WORKSPACE_SPACE_TABLE_GRID_CLASS,
                'shrink-0 border-b border-border/60 px-3 py-1.5 text-2xs font-medium uppercase tracking-wider text-muted-foreground'
              )}
            >
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
                onClick={() => toggleSort('activity')}
                className="flex items-center justify-end gap-1 text-right"
              >
                {translate('workspaceSpace.table.lastActive', 'Last active')}
                <SortIndicator sortKey="activity" activeKey={sortKey} direction={sortDirection} />
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
              <div>
                <span className="sr-only">
                  {translate('workspaceSpace.table.actions', 'Actions')}
                </span>
              </div>
            </div>

            <div ref={setScrollElement} className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
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
                <VirtualizedList
                  rows={rows}
                  getRowKey={getWorkspaceSpaceWorktreeIdentity}
                  scrollElement={scrollElement}
                  estimateRowHeightPx={33}
                  announceListPosition
                  renderRow={(worktree) => {
                    const identity = getWorkspaceSpaceWorktreeIdentity(worktree)
                    const decisionDetails = decisionDetailsByWorktreeId.get(identity)
                    if (!decisionDetails) {
                      return null
                    }
                    return (
                      <WorkspaceSpaceWorktreeRow
                        key={identity}
                        worktree={worktree}
                        selected={nextSelectedIds.has(identity)}
                        inspected={
                          inspectedWorktree !== null &&
                          getWorkspaceSpaceWorktreeIdentity(inspectedWorktree) === identity
                        }
                        decisionDetails={decisionDetails}
                        changedFiles={gitStatusByWorktreeIdentity.get(identity)}
                        gitRefreshState={gitRefreshStateByWorktreeId[identity]}
                        deleteState={getDeleteStateForWorktree(worktree)}
                        onToggleSelected={() => toggleSelection(worktree)}
                        onInspect={() => setInspectedWorktreeId(identity)}
                        onOpenWorkspace={() =>
                          window.location.pathname.endsWith('/space.html')
                            ? void window.api.workspaceSpace.revealWorktree?.(
                                worktree.worktreeId,
                                worktree.executionHostId
                              )
                            : activateAndRevealWorktree(worktree.worktreeId, {
                                navigationIntent: 'user-open',
                                executionHostId: worktree.executionHostId
                              })
                        }
                        onDelete={() => deleteWorktrees([worktree], { forceOnConfirm: true })}
                        onForceDelete={() => forceDeleteWorktree(worktree)}
                      />
                    )
                  }}
                />
              )}
            </div>
          </div>
        </div>
      ) : !analysis && !scanError ? null : (
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
    </div>
  )
}
