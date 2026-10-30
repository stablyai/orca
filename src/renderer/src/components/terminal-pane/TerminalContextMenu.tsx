import { useMemo } from 'react'
import {
  Clipboard,
  Copy,
  Eraser,
  GitFork,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelBottomClose,
  PanelsTopLeft,
  PanelRightClose,
  Pencil,
  RotateCcw,
  SquareTerminal,
  TextSelect,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  formatOptionalPrimaryShortcutLabel,
  formatPrimaryShortcutLabel
} from '@/hooks/useShortcutLabel'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import { AgentSessionContinuationMenuItem } from './AgentSessionContinuationMenuItem'
import { AgentSessionContextCopyMenuItem } from './AgentSessionContextCopyMenuItem'
import { ClearPaneTitleMenuItem } from './ClearPaneTitleMenuItem'
import type { TerminalQuickCommandMenuHost } from '@/hooks/use-terminal-quick-command-hosts'
import { TerminalQuickCommandsSubmenu } from './TerminalQuickCommandsSubmenu'

type TerminalContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuPoint: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  canClosePane: boolean
  closePaneLabel: string
  canExpandPane: boolean
  menuPaneIsExpanded: boolean
  onCopy: () => void
  onSelectAll: () => void
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  keybindings: KeybindingOverrides
  canEqualizePaneSizes: boolean
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
  onResetTerminal: () => void
  canContinueAgentSessionInNewSession: boolean
  onContinueAgentSessionInNewSession: () => void
  onForkAgentSession: () => void
  /** True when this pane may switch between the terminal and native chat views.
   *  Structured sessions are excluded — they have no terminal underneath. */
  canToggleNativeChat: boolean
  isNativeChatView: boolean
  onToggleNativeChat: () => void
  onCopyAgentSessionContext: () => void
  quickCommandHosts: TerminalQuickCommandMenuHost[]
  quickCommandHostLoadFailed: boolean
  quickCommandHostOwnershipPending: boolean
  quickCommandRepoLabel: string | null
  onQuickCommand: (command: TerminalQuickCommand, historyId: string) => void
  onAddQuickCommand: (hostId: ExecutionHostId) => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  canClearPaneTitle: boolean
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
  canCopyAgentSessionId: boolean
  onCopyAgentSessionId: () => void
}

export default function TerminalContextMenu(props: TerminalContextMenuProps): React.JSX.Element {
  const { open, onOpenChange, menuPoint, menuOpenedAtRef } = props
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && Date.now() - menuOpenedAtRef.current < 100) {
          return
        }
        onOpenChange(nextOpen)
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none absolute size-px opacity-0"
          style={{ left: menuPoint.x, top: menuPoint.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        className="min-w-60"
        sideOffset={0}
        align="start"
        onCloseAutoFocus={(e) => {
          // Keep xterm focused instead of Radix's hidden trigger.
          e.preventDefault()
        }}
        onFocusOutside={(e) => {
          // xterm reclaiming focus after contextmenu is not an outside dismissal.
          e.preventDefault()
        }}
        onPointerDownOutside={(e) => {
          if (
            shouldIgnoreTerminalMenuPointerDownOutside({
              openedAtMs: menuOpenedAtRef.current,
              nowMs: Date.now()
            })
          ) {
            e.preventDefault()
          }
        }}
      >
        <TerminalContextMenuItems {...props} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// Build menu rows only when Radix mounts the open content, after terminal activation.
function TerminalContextMenuItems({
  onOpenChange,
  canClosePane,
  closePaneLabel,
  canExpandPane,
  menuPaneIsExpanded,
  onCopy,
  onSelectAll,
  onPaste,
  onSplitRight,
  onSplitDown,
  keybindings,
  canEqualizePaneSizes,
  onEqualizePaneSizes,
  onClosePane,
  onClearScreen,
  onResetTerminal,
  canContinueAgentSessionInNewSession,
  onContinueAgentSessionInNewSession,
  onForkAgentSession,
  canToggleNativeChat,
  isNativeChatView,
  onToggleNativeChat,
  onCopyAgentSessionContext,
  quickCommandHosts,
  quickCommandHostLoadFailed,
  quickCommandHostOwnershipPending,
  quickCommandRepoLabel,
  onQuickCommand,
  onAddQuickCommand,
  onToggleExpand,
  onSetTitle,
  onClearPaneTitle,
  canClearPaneTitle,
  onCopyTerminalId,
  onCopyPaneId,
  canCopyAgentSessionId,
  onCopyAgentSessionId
}: TerminalContextMenuProps): React.JSX.Element {
  // Why: one primary binding prevents Windows/Linux shortcut labels from forcing row wraps.
  const shortcuts = useMemo(
    () => ({
      copy: formatPrimaryShortcutLabel('terminal.copySelection', keybindings),
      selectAll: formatPrimaryShortcutLabel('terminal.selectAll', keybindings),
      paste: formatPrimaryShortcutLabel('terminal.paste', keybindings),
      splitRight: formatPrimaryShortcutLabel('terminal.splitRight', keybindings),
      splitDown: formatPrimaryShortcutLabel('terminal.splitDown', keybindings),
      equalize: formatPrimaryShortcutLabel('terminal.equalizePaneSizes', keybindings),
      expand: formatPrimaryShortcutLabel('terminal.expandPane', keybindings),
      setTitle: formatPrimaryShortcutLabel('terminal.setTitle', keybindings),
      clearPaneTitle: formatPrimaryShortcutLabel('terminal.clearPaneTitle', keybindings),
      close: formatPrimaryShortcutLabel('terminal.closePane', keybindings),
      nativeChat: formatOptionalPrimaryShortcutLabel('terminal.toggleNativeChat', keybindings)
    }),
    [keybindings]
  )
  const showEqualizeShortcut = shortcuts.equalize !== 'Unassigned'
  const showSetTitleShortcut = shortcuts.setTitle !== 'Unassigned'
  const showClearPaneTitleShortcut = shortcuts.clearPaneTitle !== 'Unassigned'
  return (
    <>
      <DropdownMenuItem onSelect={onCopy}>
        <Copy />
        {translate('auto.components.terminal.pane.TerminalContextMenu.f3eeb1de13', 'Copy')}
        <DropdownMenuShortcut>{shortcuts.copy}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onSelectAll}>
        <TextSelect />
        {translate('auto.components.terminal.pane.TerminalContextMenu.selectAll', 'Select All')}
        <DropdownMenuShortcut>{shortcuts.selectAll}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onPaste}>
        <Clipboard />
        {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
        <DropdownMenuShortcut>{shortcuts.paste}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <TerminalQuickCommandsSubmenu
        hosts={quickCommandHosts}
        hostLoadFailed={quickCommandHostLoadFailed}
        hostOwnershipPending={quickCommandHostOwnershipPending}
        repoLabel={quickCommandRepoLabel}
        onRun={onQuickCommand}
        onClose={() => onOpenChange(false)}
        onAdd={onAddQuickCommand}
      />
      {canContinueAgentSessionInNewSession ? (
        <AgentSessionContinuationMenuItem onSelect={onContinueAgentSessionInNewSession} />
      ) : null}
      <DropdownMenuItem onSelect={onForkAgentSession}>
        <GitFork />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a',
          'Fork Agent Session…'
        )}
      </DropdownMenuItem>
      <AgentSessionContextCopyMenuItem onSelect={onCopyAgentSessionContext} />
      {canToggleNativeChat ? (
        <DropdownMenuItem onSelect={onToggleNativeChat}>
          {isNativeChatView ? <SquareTerminal /> : <MessageSquare />}
          {isNativeChatView
            ? translate(
                'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                'Continue with Terminal Agent'
              )
            : translate(
                'components.tab.bar.SortableTabContextMenu.switchToChatView',
                'Continue in Chat UI'
              )}
          {shortcuts.nativeChat ? (
            <DropdownMenuShortcut>{shortcuts.nativeChat}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem className="whitespace-nowrap" onSelect={onSplitRight}>
        <PanelRightClose />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
          'Split Terminal Right'
        )}
        <DropdownMenuShortcut>{shortcuts.splitRight}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem className="whitespace-nowrap" onSelect={onSplitDown}>
        <PanelBottomClose />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2',
          'Split Terminal Down'
        )}
        <DropdownMenuShortcut>{shortcuts.splitDown}</DropdownMenuShortcut>
      </DropdownMenuItem>
      {canEqualizePaneSizes && (
        <DropdownMenuItem onSelect={onEqualizePaneSizes}>
          <PanelsTopLeft />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.06c2b0f043',
            'Equalize Pane Sizes'
          )}
          {showEqualizeShortcut ? (
            <DropdownMenuShortcut>{shortcuts.equalize}</DropdownMenuShortcut>
          ) : null}
        </DropdownMenuItem>
      )}
      {canExpandPane && (
        <DropdownMenuItem onSelect={onToggleExpand}>
          {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
          {menuPaneIsExpanded
            ? translate(
                'auto.components.terminal.pane.TerminalContextMenu.df766809e0',
                'Collapse Pane'
              )
            : translate(
                'auto.components.terminal.pane.TerminalContextMenu.925f49f210',
                'Expand Pane'
              )}
          <DropdownMenuShortcut>{shortcuts.expand}</DropdownMenuShortcut>
        </DropdownMenuItem>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={() => {
          // Close focus guards before opening the title editor overlay.
          onOpenChange(false)
          onSetTitle()
        }}
      >
        <Pencil />
        {translate('auto.components.terminal.pane.TerminalContextMenu.39809d152f', 'Set Title…')}
        {showSetTitleShortcut ? (
          <DropdownMenuShortcut>{shortcuts.setTitle}</DropdownMenuShortcut>
        ) : null}
      </DropdownMenuItem>
      {canClearPaneTitle ? (
        <ClearPaneTitleMenuItem
          onSelect={onClearPaneTitle}
          shortcut={showClearPaneTitleShortcut ? shortcuts.clearPaneTitle : undefined}
        />
      ) : null}
      {canCopyAgentSessionId ? (
        <DropdownMenuItem onSelect={onCopyAgentSessionId}>
          <Copy />
          {translate(
            'components.terminalPane.TerminalContextMenu.copySessionId',
            'Copy Session ID'
          )}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={onCopyTerminalId}>
        <Copy />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.copyTerminalId',
          'Copy Terminal ID'
        )}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onCopyPaneId}>
        <Copy />
        {translate('auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55', 'Copy Pane ID')}
      </DropdownMenuItem>
      {canClosePane && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
            <X />
            {closePaneLabel}
            <DropdownMenuShortcut>{shortcuts.close}</DropdownMenuShortcut>
          </DropdownMenuItem>
        </>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={onClearScreen}>
        <Eraser />
        {translate('auto.components.terminal.pane.TerminalContextMenu.b4cdd9314e', 'Clear Screen')}
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onResetTerminal}>
        <RotateCcw />
        {translate(
          'auto.components.terminal.pane.TerminalContextMenu.resetTerminal',
          'Reset Terminal'
        )}
      </DropdownMenuItem>
    </>
  )
}
