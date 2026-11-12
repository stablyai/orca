import {
  Copy,
  Maximize2,
  Minimize2,
  PanelBottomClose,
  PanelsTopLeft,
  PanelRightClose,
  Pencil,
  X
} from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut
} from '@/components/ui/dropdown-menu'
import { ClearPaneTitleMenuItem } from '@/components/terminal-pane/titles/ClearPaneTitleMenuItem'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'

export function NativeChatPaneMenuItems({
  actions,
  splitShortcutLabels
}: {
  actions: Omit<NativeChatContextMenuActions, 'onPaste'>
  splitShortcutLabels?: { right: string; down: string }
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={actions.onSplitRight}>
        <PanelRightClose />
        {t('auto.components.terminal.pane.TerminalContextMenu.20e565d865', 'Split Terminal Right')}
        {splitShortcutLabels ? (
          <DropdownMenuShortcut>{splitShortcutLabels.right}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onSplitDown}>
        <PanelBottomClose />
        {t('auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2', 'Split Terminal Down')}
        {splitShortcutLabels ? (
          <DropdownMenuShortcut>{splitShortcutLabels.down}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      {actions.canEqualizePaneSizes ? (
        <DropdownMenuItem onSelect={actions.onEqualizePaneSizes}>
          <PanelsTopLeft />
          {t('auto.components.terminal.pane.TerminalContextMenu.06c2b0f043', 'Equalize Pane Sizes')}
        </DropdownMenuItem>
      ) : null}
      {actions.canExpandPane ? (
        <DropdownMenuItem onSelect={actions.onToggleExpand}>
          {actions.isPaneExpanded ? <Minimize2 /> : <Maximize2 />}
          {actions.isPaneExpanded
            ? t('auto.components.terminal.pane.TerminalContextMenu.df766809e0', 'Collapse Pane')
            : t('auto.components.terminal.pane.TerminalContextMenu.925f49f210', 'Expand Pane')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={actions.onSetTitle}>
        <Pencil />
        {t('auto.components.terminal.pane.TerminalContextMenu.39809d152f', 'Set Title…')}
      </DropdownMenuItem>
      {actions.canClearPaneTitle ? (
        <ClearPaneTitleMenuItem onSelect={actions.onClearPaneTitle} />
      ) : null}
      {actions.canCopyAgentSessionId ? (
        <DropdownMenuItem onSelect={actions.onCopyAgentSessionId}>
          <Copy />
          {t('components.terminalPane.TerminalContextMenu.copySessionId', 'Copy Session ID')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={actions.onCopyTerminalId}>
        <Copy />
        {t('auto.components.terminal.pane.TerminalContextMenu.copyTerminalId', 'Copy Terminal ID')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onCopyPaneId}>
        <Copy />
        {t('auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55', 'Copy Pane ID')}
      </DropdownMenuItem>
      {actions.canClosePane ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={actions.onClosePane}>
            <X />
            {t('auto.components.terminal.pane.TerminalContextMenu.8c17d6786d', 'Close Pane')}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}
