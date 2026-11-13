import { Button } from '../ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceGridViewCellRect } from '@/lib/workspace/grid-view/workspace-grid-view-cell-rects'
import { focusWorkspaceGridViewMember } from '@/lib/workspace/grid-view/workspace-grid-view-actions'
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
  isFocused,
  isOpening
}: {
  workspaceId: string
  workspacePath: string
  rect: WorkspaceGridViewCellRect
  isFocused: boolean
  /** True while the member is being opened or restored, so there is nothing to offer yet. */
  isOpening: boolean
}): React.JSX.Element {
  const t = useTranslate()
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
        isFocused={isFocused}
        windowCorners={workspaceGridViewCellWindowCorners(rect)}
      />
      <div className="flex flex-1 items-center justify-center bg-background">
        {isOpening ? (
          <span className="text-xs text-muted-foreground">
            {t(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openingWorkspace',
              'Opening workspace…'
            )}
          </span>
        ) : (
          <Button
            variant="outline"
            size="sm"
            aria-label={t(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openNamedWorkspace',
              'Open Workspace: {{value0}}',
              { value0: spokenName }
            )}
            onClick={() => focusWorkspaceGridViewMember(workspaceId)}
          >
            {t(
              'auto.components.workspace-grid-view.WorkspaceGridViewEmptyCell.openWorkspace',
              'Open Workspace'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
