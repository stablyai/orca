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
import { ClearPaneTitleMenuItem } from '@/components/terminal-pane/ClearPaneTitleMenuItem'
import { translate } from '@/i18n/i18n'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'
import { useAppStore } from '@/store'
import { useStructuredChatPaneActions } from './use-structured-chat-pane-actions'
import { NativeChatCopyOrcaSessionIdMenuItem } from './NativeChatCopyOrcaSessionIdMenuItem'

export function StructuredChatPaneMenuItems({
  pane,
  leadingSeparator,
  splitShortcutLabels,
  resolveOrcaSessionId
}: {
  pane: { tabId: string; worktreeId: string; groupId: string }
  leadingSeparator: boolean
  splitShortcutLabels?: { right: string; down: string }
  resolveOrcaSessionId?: () => Promise<string | null>
}) {
  const actions = useStructuredChatPaneActions(pane.tabId, pane.worktreeId, pane.groupId)
  const hasSplitPanes = useAppStore(
    (state) => (state.groupsByWorktree[pane.worktreeId]?.length ?? 0) > 1
  )
  return (
    <>
      {leadingSeparator ? <DropdownMenuSeparator /> : null}
      <DropdownMenuItem onSelect={actions.onSplitRight}>
        <PanelRightClose />
        {translate('auto.components.cmd.j.quick.actions.splitChatRight', 'Split Chat Right')}
        <DropdownMenuShortcut>{splitShortcutLabels?.right}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onSplitDown}>
        <PanelBottomClose />
        {translate('auto.components.cmd.j.quick.actions.splitChatDown', 'Split Chat Down')}
        <DropdownMenuShortcut>{splitShortcutLabels?.down}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {resolveOrcaSessionId ? (
        <>
          <DropdownMenuSeparator />
          <NativeChatCopyOrcaSessionIdMenuItem resolveOrcaSessionId={resolveOrcaSessionId} />
        </>
      ) : null}
      {hasSplitPanes && actions.canClosePane ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={actions.onClosePane}>
            <X />
            {actions.closeLabel}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}

/** The terminal pane's layout and identity rows, for a chat that sits in a terminal pane. */
export function NativeChatPaneMenuItems({
  actions,
  splitShortcutLabels
}: {
  actions: Omit<NativeChatContextMenuActions, 'onPaste'>
  splitShortcutLabels?: { right: string; down: string }
}): React.JSX.Element {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={actions.onSplitRight}>
        <PanelRightClose />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
          'Split Terminal Right'
        )}
        {splitShortcutLabels ? (
          <DropdownMenuShortcut>{splitShortcutLabels.right}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onSplitDown}>
        <PanelBottomClose />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2',
          'Split Terminal Down'
        )}
        {splitShortcutLabels ? (
          <DropdownMenuShortcut>{splitShortcutLabels.down}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      {actions.canEqualizePaneSizes ? (
        <DropdownMenuItem onSelect={actions.onEqualizePaneSizes}>
          <PanelsTopLeft />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.06c2b0f043',
            'Equalize Pane Sizes'
          )}
        </DropdownMenuItem>
      ) : null}
      {actions.canExpandPane ? (
        <DropdownMenuItem onSelect={actions.onToggleExpand}>
          {actions.isPaneExpanded ? <Minimize2 /> : <Maximize2 />}
          {actions.isPaneExpanded
            ? translate(
                'auto.components.terminal.pane.TerminalContextMenu.df766809e0',
                'Collapse Pane'
              )
            : translate(
                'auto.components.terminal.pane.TerminalContextMenu.925f49f210',
                'Expand Pane'
              )}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={actions.onSetTitle}>
        <Pencil />
        {translate('auto.components.terminal.pane.TerminalContextMenu.39809d152f', 'Set Title…')}
      </DropdownMenuItem>
      {actions.canClearPaneTitle ? (
        <ClearPaneTitleMenuItem onSelect={actions.onClearPaneTitle} />
      ) : null}
      {actions.canCopyAgentSessionId ? (
        <DropdownMenuItem onSelect={actions.onCopyAgentSessionId}>
          <Copy />
          {translate(
            'components.terminalPane.TerminalContextMenu.copySessionId',
            'Copy Session ID'
          )}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={actions.onCopyTerminalId}>
        <Copy />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.copyTerminalId',
          'Copy Terminal ID'
        )}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={actions.onCopyPaneId}>
        <Copy />
        {translate('auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55', 'Copy Pane ID')}
      </DropdownMenuItem>
      {actions.canClosePane ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={actions.onClosePane}>
            <X />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
              'Close Pane'
            )}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  )
}
