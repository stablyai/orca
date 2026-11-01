import {
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, FolderGit2 } from 'lucide-react'
import type { TabSplitDirection } from '../../store/slices/tabs'
import { translate } from '@/i18n/i18n'
import {
  canMoveTabToNewPaneColumn,
  moveTabToNewPaneColumn,
  moveTabToTargetWorktree,
  resolveMoveToWorktreeTargets
} from './tab-move-to-pane-column'

const PANE_COLUMN_DIRECTIONS: TabSplitDirection[] = ['right', 'left', 'down', 'up']

function paneColumnDirectionIcon(direction: TabSplitDirection): React.JSX.Element {
  switch (direction) {
    case 'right':
      return <ArrowRight className="size-3.5 shrink-0" />
    case 'left':
      return <ArrowLeft className="size-3.5 shrink-0" />
    case 'down':
      return <ArrowDown className="size-3.5 shrink-0" />
    case 'up':
      return <ArrowUp className="size-3.5 shrink-0" />
  }
}

function paneColumnDirectionLabel(direction: TabSplitDirection): string {
  switch (direction) {
    case 'right':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.right', 'Right')
    case 'left':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.left', 'Left')
    case 'down':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.down', 'Down')
    case 'up':
      return translate('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.up', 'Up')
  }
}

export function TabWorkspaceLayoutMenuSection({
  unifiedTabId,
  groupId,
  leadingSeparator = false,
  trailingSeparator = false,
  shortcutLabels
}: {
  unifiedTabId: string
  groupId: string
  leadingSeparator?: boolean
  trailingSeparator?: boolean
  shortcutLabels?: Partial<Record<TabSplitDirection, string>>
}): React.JSX.Element | null {
  const canSplit = canMoveTabToNewPaneColumn(unifiedTabId, groupId)
  const worktreeTargets = resolveMoveToWorktreeTargets(unifiedTabId)
  if (!canSplit && worktreeTargets.length === 0) {
    return null
  }

  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      {canSplit ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
            <Columns2 className="size-3.5 shrink-0" />
            {translate(
              'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
              'Move Tab to Split'
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            animation="none"
            className="max-w-[calc(100vw-1rem)] whitespace-nowrap"
          >
            {PANE_COLUMN_DIRECTIONS.map((direction) => (
              <ContextMenuItem
                key={direction}
                onSelect={() => {
                  moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
                }}
              >
                {paneColumnDirectionIcon(direction)}
                {paneColumnDirectionLabel(direction)}
                {shortcutLabels?.[direction] ? (
                  <ContextMenuShortcut>{shortcutLabels[direction]}</ContextMenuShortcut>
                ) : null}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      {worktreeTargets.length > 0 ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
            <FolderGit2 className="size-3.5 shrink-0" />
            {translate(
              'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToWorkspace',
              'Move to Workspace'
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            animation="none"
            className="max-w-[calc(100vw-1rem)] whitespace-nowrap"
          >
            {worktreeTargets.map((target) => (
              <ContextMenuItem
                key={target.id}
                onSelect={() => {
                  moveTabToTargetWorktree(unifiedTabId, target.id)
                }}
              >
                <FolderGit2 className="size-3.5 shrink-0" />
                {target.label}
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      {trailingSeparator ? <ContextMenuSeparator /> : null}
    </>
  )
}
