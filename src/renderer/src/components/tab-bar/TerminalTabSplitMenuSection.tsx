import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { PanelBottomClose, PanelRightClose, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { requestActiveTerminalPaneSplit } from './request-active-terminal-pane-split'
import { cn } from '@/lib/utils'

export function TerminalTabSplitMenuSection({
  unifiedTabId,
  groupId,
  tabId,
  isActive,
  onActivate,
  splitRightShortcut,
  splitDownShortcut,
  showTerminalSplit = true,
  trailingSeparator = false
}: {
  unifiedTabId: string
  groupId: string
  tabId: string
  isActive: boolean
  onActivate: (tabId: string) => void
  splitRightShortcut: string
  splitDownShortcut: string
  showTerminalSplit?: boolean
  trailingSeparator?: boolean
}): React.JSX.Element {
  const splitActiveTerminalPane = (direction: 'vertical' | 'horizontal'): void => {
    if (!isActive) {
      onActivate(tabId)
    }
    requestActiveTerminalPaneSplit({ tabId, direction })
  }

  return (
    <>
      <TabWorkspaceLayoutMenuSection unifiedTabId={unifiedTabId} groupId={groupId} />
      {showTerminalSplit ? (
        <ContextMenuSub>
          <ContextMenuSubTrigger className="[&>svg:last-child]:size-3.5">
            <SquareTerminal className="size-3.5 shrink-0" />
            {translate(
              'auto.components.tab.bar.TerminalTabSplitMenuSection.splitTerminal',
              'Split terminal'
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent
            animation="none"
            className={cn('min-w-[12rem]', 'max-w-[calc(100vw-1rem)] whitespace-nowrap')}
          >
            <ContextMenuItem onSelect={() => splitActiveTerminalPane('vertical')}>
              <PanelRightClose className="size-3.5 shrink-0" />
              {translate(
                'auto.components.tab.bar.SortableTabContextMenu.splitTerminalRight',
                'Split terminal right'
              )}
              <ContextMenuShortcut>{splitRightShortcut}</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem onSelect={() => splitActiveTerminalPane('horizontal')}>
              <PanelBottomClose className="size-3.5 shrink-0" />
              {translate(
                'auto.components.tab.bar.SortableTabContextMenu.splitTerminalDown',
                'Split terminal down'
              )}
              <ContextMenuShortcut>{splitDownShortcut}</ContextMenuShortcut>
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
      ) : null}
      {trailingSeparator ? <ContextMenuSeparator /> : null}
    </>
  )
}
