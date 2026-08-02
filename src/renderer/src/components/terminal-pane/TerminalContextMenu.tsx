import { useMemo } from 'react'
import {
  Clipboard,
  ClipboardCopy,
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
  Play,
  Plus,
  SquareTerminal,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { isTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import { formatPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { AgentIcon } from '@/lib/agent-catalog'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'
import { isMacPlatform, nativeChatToggleShortcutLabel } from '../native-chat/native-chat-shortcut'
import { AgentSessionContinuationMenuItem } from './AgentSessionContinuationMenuItem'

type TerminalContextMenuProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  menuPoint: { x: number; y: number }
  menuOpenedAtRef: React.RefObject<number>
  canClosePane: boolean
  canExpandPane: boolean
  menuPaneIsExpanded: boolean
  onCopy: () => void
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
  canToggleNativeChat: boolean
  isNativeChatView: boolean
  onToggleNativeChat: () => void
  onCopyAgentSessionContext: () => void
  repoQuickCommands: TerminalQuickCommand[]
  globalQuickCommands: TerminalQuickCommand[]
  quickCommandRepoLabel: string | null
  onQuickCommand: (command: TerminalQuickCommand) => void
  onAddQuickCommand: () => void
  onToggleExpand: () => void
  onSetTitle: () => void
  onClearPaneTitle: () => void
  canClearPaneTitle: boolean
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
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
  canToggleNativeChat,
  isNativeChatView,
  onToggleNativeChat,
  onCopyAgentSessionContext,
  repoQuickCommands,
  globalQuickCommands,
  quickCommandRepoLabel,
  onQuickCommand,
  onAddQuickCommand,
  onToggleExpand,
  onSetTitle,
  onClearPaneTitle,
  canClearPaneTitle,
  onCopyTerminalId,
  onCopyPaneId
}: TerminalContextMenuProps): React.JSX.Element {
  // Why: Windows/Linux shortcut labels are long; context menu rows should show
  // the primary binding only so alternative bindings do not force row wraps.
  const shortcuts = useMemo(
    () => ({
      copy: formatPrimaryShortcutLabel('terminal.copySelection', keybindings),
      paste: formatPrimaryShortcutLabel('terminal.paste', keybindings),
      splitRight: formatPrimaryShortcutLabel('terminal.splitRight', keybindings),
      splitDown: formatPrimaryShortcutLabel('terminal.splitDown', keybindings),
      equalize: formatPrimaryShortcutLabel('terminal.equalizePaneSizes', keybindings),
      expand: formatPrimaryShortcutLabel('terminal.expandPane', keybindings),
      setTitle: formatPrimaryShortcutLabel('terminal.setTitle', keybindings),
      clearPaneTitle: formatPrimaryShortcutLabel('terminal.clearPaneTitle', keybindings),
      close: formatPrimaryShortcutLabel('terminal.closePane', keybindings),
      nativeChat: nativeChatToggleShortcutLabel(isMacPlatform())
    }),
    [keybindings]
  )
  const hasQuickCommands = repoQuickCommands.length > 0 || globalQuickCommands.length > 0
  const showEqualizeShortcut = shortcuts.equalize !== 'Unassigned'
  const showSetTitleShortcut = shortcuts.setTitle !== 'Unassigned'
  const showClearPaneTitleShortcut = shortcuts.clearPaneTitle !== 'Unassigned'
  const renderQuickCommandItem = (command: TerminalQuickCommand): React.JSX.Element => (
    <DropdownMenuItem key={command.id} onSelect={() => onQuickCommand(command)}>
      {isTerminalAgentQuickCommand(command) ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <AgentIcon agent={command.agent} size={14} />
        </span>
      ) : (
        <Play
          className="size-3.5 shrink-0 text-muted-foreground"
          fill="currentColor"
          strokeWidth={0}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {!isTerminalAgentQuickCommand(command) && !command.appendEnter ? (
        <DropdownMenuShortcut className="shrink-0">
          {translate('auto.components.terminal.pane.TerminalContextMenu.c2f0b72b8d', 'Insert')}
        </DropdownMenuShortcut>
      ) : null}
    </DropdownMenuItem>
  )

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
          // Prevent Radix from moving focus back to the hidden trigger;
          // let xterm keep focus naturally.
          e.preventDefault()
        }}
        onFocusOutside={(e) => {
          // xterm reclaims focus after the contextmenu event; don't let
          // Radix treat that as a dismiss signal.
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
        <DropdownMenuItem onSelect={onPaste}>
          <Clipboard />
          {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
          <DropdownMenuShortcut>{shortcuts.paste}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Play fill="currentColor" strokeWidth={0} />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.ec85df5914',
              'Quick Commands'
            )}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            {hasQuickCommands ? (
              <>
                {quickCommandRepoLabel && repoQuickCommands.length > 0 ? (
                  <>
                    <DropdownMenuLabel className="truncate">
                      {quickCommandRepoLabel}
                    </DropdownMenuLabel>
                    {repoQuickCommands.map(renderQuickCommandItem)}
                  </>
                ) : null}
                {globalQuickCommands.length > 0 ? (
                  <>
                    {repoQuickCommands.length > 0 ? <DropdownMenuSeparator /> : null}
                    {repoQuickCommands.length > 0 ? (
                      <DropdownMenuLabel>
                        {translate(
                          'auto.components.terminal.pane.TerminalContextMenu.3ce594a4a0',
                          'Global'
                        )}
                      </DropdownMenuLabel>
                    ) : null}
                    {globalQuickCommands.map(renderQuickCommandItem)}
                  </>
                ) : null}
              </>
            ) : (
              <DropdownMenuItem disabled className="text-muted-foreground">
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.9528a65ef8',
                  'No quick commands'
                )}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                // Why: the dropdown sits above dialogs; force-close before
                // opening the add modal even during the open-gesture guard.
                onOpenChange(false)
                onAddQuickCommand()
              }}
            >
              <Plus />
              {translate(
                'auto.components.terminal.pane.TerminalContextMenu.0a82b0608c',
                'Add Quick Command…'
              )}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
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
        {canToggleNativeChat ? (
          <DropdownMenuItem onSelect={onToggleNativeChat}>
            {isNativeChatView ? <SquareTerminal /> : <MessageSquare />}
            {isNativeChatView
              ? translate(
                  'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                  'Switch to terminal view'
                )
              : translate(
                  'components.tab.bar.SortableTabContextMenu.switchToChatView',
                  'Switch to chat view'
                )}
            <DropdownMenuShortcut>{shortcuts.nativeChat}</DropdownMenuShortcut>
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
