import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { PanelBottomClose, PanelRightClose, SquareTerminal } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { requestActiveTerminalPaneSplit } from './request-active-terminal-pane-split'

export function TerminalTabSplitMenuSection({
  unifiedTabId,
  groupId,
  tabId,
  isActive,
  onActivate,
  splitRightShortcut,
  splitDownShortcut,
  trailingSeparator = false
}: {
  unifiedTabId: string
  groupId: string
  tabId: string
  isActive: boolean
  onActivate: (tabId: string) => void
  splitRightShortcut: string
  splitDownShortcut: string
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
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="[&>svg:last-child]:size-3.5">
          <SquareTerminal className="size-3.5 shrink-0" />
          {translate(
            'auto.components.tab.bar.TerminalTabSplitMenuSection.splitTerminal',
            'Split terminal'
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[12rem]">
          <DropdownMenuItem onSelect={() => splitActiveTerminalPane('vertical')}>
            <PanelRightClose className="size-3.5 shrink-0" />
            {translate(
              'auto.components.tab.bar.SortableTabContextMenu.splitTerminalRight',
              'Split terminal right'
            )}
            <DropdownMenuShortcut>{splitRightShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => splitActiveTerminalPane('horizontal')}>
            <PanelBottomClose className="size-3.5 shrink-0" />
            {translate(
              'auto.components.tab.bar.SortableTabContextMenu.splitTerminalDown',
              'Split terminal down'
            )}
            <DropdownMenuShortcut>{splitDownShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {trailingSeparator ? <DropdownMenuSeparator /> : null}
    </>
  )
}
