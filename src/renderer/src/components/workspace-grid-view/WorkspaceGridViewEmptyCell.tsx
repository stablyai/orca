import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { WorkspaceGridViewCellRect } from '@/lib/workspace-grid-view-cell-rects'
import { focusWorkspaceGridViewMember } from '@/lib/workspace-grid-view-actions'
import {
  WorkspaceGridViewCellHeader,
  useWorkspaceGridViewCellName
} from './WorkspaceGridViewCellHeader'
import {
  workspaceGridViewCellClassName,
  workspaceGridViewCellStyle,
  workspaceGridViewCellWindowCorners
} from './workspace-grid-view-cell-frame'

/** A grid view member with no tab layout yet, e.g. a workspace added before it was ever opened. */
export function WorkspaceGridViewEmptyCell({
  workspaceId,
  workspacePath,
  rect,
  isOpening
}: {
  workspaceId: string
  workspacePath: string
  rect: WorkspaceGridViewCellRect
  /** True once the member is active and its first tab is still being created. */
  isOpening: boolean
}): React.JSX.Element {
  const { spokenName } = useWorkspaceGridViewCellName(workspaceId, workspacePath)
  return (
    <div
      className={workspaceGridViewCellClassName(rect)}
      style={workspaceGridViewCellStyle(rect)}
      data-workspace-grid-view-cell={workspaceId}
    >
      <WorkspaceGridViewCellHeader
        workspaceId={workspaceId}
        workspacePath={workspacePath}
        isFocused={isOpening}
        windowCorners={workspaceGridViewCellWindowCorners(rect)}
      />
      <div className="flex flex-1 items-center justify-center bg-background">
        {isOpening ? (
          <span className="text-xs text-muted-foreground">
            {translate(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openingWorkspace',
              'Opening workspace…'
            )}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label={translate(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openNamedWorkspace',
              'Open Workspace: {{value0}}',
              { value0: spokenName }
            )}
            onClick={() => focusWorkspaceGridViewMember(workspaceId)}
          >
            {translate(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openWorkspace',
              'Open Workspace'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
