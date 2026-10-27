import { X } from 'lucide-react'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'
import { getTabRootStateClasses } from '../tab-bar/drop-indicator'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { cn } from '@/lib/utils'
import { removeWorkspaceFromGridViewKeepingFocus } from '@/lib/workspace-grid-view-actions'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR } from './workspace-grid-view-cell-frame'

// Why the tab-strip look: the focused cell reads like the focused tab, with the same tint and bar.
const FOCUSED_CELL_INDICATOR_CLASSES =
  'pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-foreground'

function selectWorkspaceGridViewCellTitle(
  state: AppState,
  workspaceId: string,
  workspacePath: string
): string {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = selectFolderWorkspaces(state).find((row) => row.id === scope.folderWorkspaceId)
    return folder?.name.trim() || basename(workspacePath)
  }
  const worktree = state.getKnownWorktreeById(workspaceId)
  return (worktree ? resolveWorktreeDisplayName(worktree) : '') || basename(workspacePath)
}

function selectWorkspaceGridViewCellRepoName(state: AppState, workspaceId: string): string | null {
  if (parseWorkspaceKey(workspaceId)?.type === 'folder') {
    return null
  }
  const repoId = state.getKnownWorktreeById(workspaceId)?.repoId
  return state.repos.find((repo) => repo.id === repoId)?.displayName ?? null
}

/** A cell's title and project, plus the name its controls announce. */
export function useWorkspaceGridViewCellName(
  workspaceId: string,
  workspacePath: string
): { title: string; repoName: string | null; spokenName: string } {
  const title = useAppStore((state) =>
    selectWorkspaceGridViewCellTitle(state, workspaceId, workspacePath)
  )
  const repoName = useAppStore((state) => selectWorkspaceGridViewCellRepoName(state, workspaceId))
  // Why the project: two projects' `main` branches would otherwise announce the same name.
  const spokenName = repoName
    ? translate(
        'auto.components.workspace-grid-view.WorkspaceGridViewCellHeader.cellNameWithProject',
        '{{value0}} ({{value1}})',
        { value0: title, value1: repoName }
      )
    : title
  return { title, repoName, spokenName }
}

export function WorkspaceGridViewCellHeader({
  workspaceId,
  workspacePath,
  isFocused,
  windowCorners
}: {
  workspaceId: string
  workspacePath: string
  isFocused: boolean
  /** Corners where the floating sidebar toggles and window controls overlay this header. */
  windowCorners: { topLeft: boolean; topRight: boolean }
}): React.JSX.Element {
  const { title, repoName, spokenName } = useWorkspaceGridViewCellName(workspaceId, workspacePath)
  const clearsLeftCorner = useAppStore((state) => windowCorners.topLeft && !state.sidebarOpen)
  const clearsRightCorner = useAppStore(
    (state) => windowCorners.topRight && !state.rightSidebarOpen
  )
  const removeLabel = translate(
    'auto.components.workspace-grid-view.WorkspaceGridViewCellHeader.removeFromGridView',
    'Remove from Grid View'
  )
  // Why name the workspace: every cell has a remove button, so the bare action is ambiguous.
  const removeAccessibleName = translate(
    'auto.components.workspace-grid-view.WorkspaceGridViewCellHeader.removeNamedFromGridView',
    'Remove from Grid View: {{value0}}',
    { value0: spokenName }
  )

  return (
    <div
      data-workspace-grid-view-cell-header=""
      data-current={isFocused ? 'true' : undefined}
      className={cn(
        'absolute inset-x-0 top-0 flex h-7 items-center gap-1.5 border-b border-border px-2 text-xs',
        getTabRootStateClasses(isFocused)
      )}
    >
      {isFocused ? <span className={FOCUSED_CELL_INDICATOR_CLASSES} aria-hidden /> : null}
      {/* Why: same clearance the top tab row reserves, so the title and × stay out from under the
          collapsed sidebar toggle, the explorer toggle, and Windows/Linux window controls. */}
      {clearsLeftCorner ? (
        <div className="shrink-0" style={{ width: 'var(--collapsed-sidebar-header-width)' }} />
      ) : null}
      <span className="min-w-0 truncate font-medium">{title}</span>
      {repoName ? <span className="min-w-0 truncate text-muted-foreground">{repoName}</span> : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto shrink-0"
            aria-label={removeAccessibleName}
            {...{ [WORKSPACE_GRID_VIEW_CELL_ACTION_ATTR]: 'remove' }}
            onClick={() => removeWorkspaceFromGridViewKeepingFocus(workspaceId)}
          >
            <X className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {removeLabel}
        </TooltipContent>
      </Tooltip>
      {clearsRightCorner ? (
        <div
          className="shrink-0"
          style={{ width: 'calc(40px + var(--window-controls-width, 0px))' }}
        />
      ) : null}
    </div>
  )
}
