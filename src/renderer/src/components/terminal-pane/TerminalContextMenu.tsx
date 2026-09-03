import { useMemo } from 'react'
import {
  Clipboard,
  ClipboardCopy,
  Copy,
  Eraser,
  GitFork,
  Maximize2,
  Minimize2,
  PanelBottomClose,
  PanelsTopLeft,
  PanelRightClose,
  Pencil,
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
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import { AgentSessionContinuationMenuItem } from './AgentSessionContinuationMenuItem'
import type { TerminalQuickCommandMenuHost } from '@/hooks/use-terminal-quick-command-hosts'
import { TerminalQuickCommandsSubmenu } from './TerminalQuickCommandsSubmenu'

type TerminalContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuPoint: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  canClosePane: boolean
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
  canContinueAgentSessionInNewSession: boolean
  onContinueAgentSessionInNewSession: () => void
  onForkAgentSession: () => void
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

export default function TerminalContextMenu({
  open,
  onOpenChange,
  menuPoint,
  menuOpenedAtRef,
  canClosePane,
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
  canContinueAgentSessionInNewSession,
  onContinueAgentSessionInNewSession,
  onForkAgentSession,
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
      close: formatPrimaryShortcutLabel('terminal.closePane', keybindings)
    }),
    [keybindings]
  )
  const showEqualizeShortcut = shortcuts.equalize !== 'Unassigned'
  const showSetTitleShortcut = shortcuts.setTitle !== 'Unassigned'
  const showClearPaneTitleShortcut = shortcuts.clearPaneTitle !== 'Unassigned'
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
        className="w-60"
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
        <DropdownMenuItem onSelect={onCopyAgentSessionContext}>
          <ClipboardCopy />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.cff67afad1',
            'Copy Context'
          )}
        </DropdownMenuItem>
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
            // Why: Set Title moves focus into an overlay input. Force-close
            // before opening it so the menu's focus guards are not still active.
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
          <DropdownMenuItem onSelect={onClearPaneTitle}>
            <X />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.clearPaneTitle',
              'Clear Pane Title'
            )}
            {showClearPaneTitleShortcut ? (
              <DropdownMenuShortcut>{shortcuts.clearPaneTitle}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
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
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55',
            'Copy Pane ID'
          )}
        </DropdownMenuItem>
        {canClosePane && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
              <X />
              {translate(
                'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
                'Close Pane'
              )}
              <DropdownMenuShortcut>{shortcuts.close}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClearScreen}>
          <Eraser />
          {translate(
            'auto.components.terminal.pane.TerminalContextMenu.b4cdd9314e',
            'Clear Screen'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
