import {
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuShortcut
} from '@/components/ui/context-menu'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2 } from 'lucide-react'
import type { TabSplitDirection } from '../../../store/slices/tabs/tabs-slice-contract'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { canMoveTabToNewPaneColumn, moveTabToNewPaneColumn } from './tab-move-to-pane-column'
import { useAppStore } from '../../../store/index'
import { formatOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import {
  TAB_MOVE_TO_SPLIT_DIRECTIONS,
  tabMoveToSplitActionId
} from '../../../../../shared/keybindings/tab-move-to-split-definitions'

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

function paneColumnDirectionLabel(direction: TabSplitDirection, t: Translate = translate): string {
  switch (direction) {
    case 'right':
      return t('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.right', 'Right')
    case 'left':
      return t('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.left', 'Left')
    case 'down':
      return t('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.down', 'Down')
    case 'up':
      return t('auto.components.tab.bar.TabWorkspaceLayoutMenuSection.up', 'Up')
  }
}

export function TabWorkspaceLayoutMenuSection({
  unifiedTabId,
  groupId,
  leadingSeparator = false,
  trailingSeparator = false
}: {
  unifiedTabId: string
  groupId: string
  leadingSeparator?: boolean
  trailingSeparator?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const keybindings = useAppStore((state) => state.keybindings)
  if (!canMoveTabToNewPaneColumn(unifiedTabId, groupId)) {
    return null
  }

  return (
    <>
      {leadingSeparator ? <ContextMenuSeparator /> : null}
      <ContextMenuSub>
        <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <Columns2 className="size-3.5 shrink-0" />
          {t(
            'auto.components.tab.bar.TabWorkspaceLayoutMenuSection.moveToPaneColumn',
            'Move Tab to Split'
          )}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent
          animation="none"
          className="max-w-[calc(100vw-1rem)] whitespace-nowrap"
        >
          {TAB_MOVE_TO_SPLIT_DIRECTIONS.map((direction) => {
            const shortcut = formatOptionalShortcutLabel(
              tabMoveToSplitActionId(direction),
              keybindings
            )
            return (
              <ContextMenuItem
                key={direction}
                onSelect={() => {
                  moveTabToNewPaneColumn({ unifiedTabId, groupId, direction })
                }}
              >
                {paneColumnDirectionIcon(direction)}
                {paneColumnDirectionLabel(direction, t)}
                {shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null}
              </ContextMenuItem>
            )
          })}
        </ContextMenuSubContent>
      </ContextMenuSub>
      {trailingSeparator ? <ContextMenuSeparator /> : null}
    </>
  )
}
