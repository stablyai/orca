import { useMemo } from 'react'
import {
  Clipboard,
  Copy,
  Eraser,
  GitFork,
  Maximize2,
  Minimize2,
  PanelBottomClose,
  PanelsTopLeft,
  PanelRightClose,
  Pencil,
  Play,
  Plus,
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
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'
import { AgentIcon } from '@/lib/agent-catalog'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { translate } from '@/i18n/i18n'

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
  onForkAgentSession: () => void
  repoQuickCommands: TerminalQuickCommand[]
  globalQuickCommands: TerminalQuickCommand[]
  quickCommandRepoLabel: string | null
  onQuickCommand: (command: TerminalQuickCommand) => void
  onAddQuickCommand: () => void
  onToggleExpand: () => void
  onSetTitle: () => void
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
  onForkAgentSession,
  repoQuickCommands,
  globalQuickCommands,
  quickCommandRepoLabel,
  onQuickCommand,
  onAddQuickCommand,
  onToggleExpand,
  onSetTitle,
  onCopyPaneId
}: TerminalContextMenuProps): React.JSX.Element {
  const shortcuts = useMemo(
    () => ({
      copy: formatShortcutLabel('terminal.copySelection', keybindings),
      paste: formatShortcutLabel('terminal.paste', keybindings),
      splitRight: formatShortcutLabel('terminal.splitRight', keybindings),
      splitDown: formatShortcutLabel('terminal.splitDown', keybindings),
      equalize: formatShortcutLabel('terminal.equalizePaneSizes', keybindings),
      expand: formatShortcutLabel('terminal.expandPane', keybindings),
      close: formatShortcutLabel('terminal.closePane', keybindings)
    }),
    [keybindings]
  )
  const hasQuickCommands = repoQuickCommands.length > 0 || globalQuickCommands.length > 0
  const showEqualizeShortcut = shortcuts.equalize !== 'Unassigned'
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
        <DropdownMenuShortcut className="shrink-0">{translate("auto.components.terminal.pane.TerminalContextMenu.c2f0b72b8d", "Insert")}</DropdownMenuShortcut>
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
        className="w-52"
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
          {translate("auto.components.terminal.pane.TerminalContextMenu.f3eeb1de13", "Copy")}<DropdownMenuShortcut>{shortcuts.copy}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste}>
          <Clipboard />
          {translate("auto.components.terminal.pane.TerminalContextMenu.0a917b591a", "Paste")}<DropdownMenuShortcut>{shortcuts.paste}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Play fill="currentColor" strokeWidth={0} />
            {translate("auto.components.terminal.pane.TerminalContextMenu.ec85df5914", "Quick Commands")}</DropdownMenuSubTrigger>
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
                      <DropdownMenuLabel>{translate("auto.components.terminal.pane.TerminalContextMenu.3ce594a4a0", "Global")}</DropdownMenuLabel>
                    ) : null}
                    {globalQuickCommands.map(renderQuickCommandItem)}
                  </>
                ) : null}
              </>
            ) : (
              <DropdownMenuItem disabled className="text-muted-foreground">
                {translate("auto.components.terminal.pane.TerminalContextMenu.9528a65ef8", "No quick commands")}</DropdownMenuItem>
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
              {translate("auto.components.terminal.pane.TerminalContextMenu.0a82b0608c", "Add Quick Command…")}</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onForkAgentSession}>
          <GitFork />
          {translate("auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a", "Fork Agent Session…")}</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSplitRight}>
          <PanelRightClose />
          {translate("auto.components.terminal.pane.TerminalContextMenu.20e565d865", "Split Terminal Right")}<DropdownMenuShortcut>{shortcuts.splitRight}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSplitDown}>
          <PanelBottomClose />
          {translate("auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2", "Split Terminal Down")}<DropdownMenuShortcut>{shortcuts.splitDown}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canEqualizePaneSizes && (
          <DropdownMenuItem onSelect={onEqualizePaneSizes}>
            <PanelsTopLeft />
            {translate("auto.components.terminal.pane.TerminalContextMenu.06c2b0f043", "Equalize Pane Sizes")}{showEqualizeShortcut ? (
              <DropdownMenuShortcut>{shortcuts.equalize}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )}
        {canExpandPane && (
          <DropdownMenuItem onSelect={onToggleExpand}>
            {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
            {menuPaneIsExpanded ? translate("auto.components.terminal.pane.TerminalContextMenu.df766809e0", "Collapse Pane") : translate("auto.components.terminal.pane.TerminalContextMenu.925f49f210", "Expand Pane")}
            <DropdownMenuShortcut>{shortcuts.expand}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSetTitle}>
          <Pencil />
          {translate("auto.components.terminal.pane.TerminalContextMenu.39809d152f", "Set Title…")}</DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPaneId}>
          <Copy />
          {translate("auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55", "Copy Pane ID")}</DropdownMenuItem>
        {canClosePane && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
              <X />
              {translate("auto.components.terminal.pane.TerminalContextMenu.8c17d6786d", "Close Pane")}<DropdownMenuShortcut>{shortcuts.close}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClearScreen}>
          <Eraser />
          {translate("auto.components.terminal.pane.TerminalContextMenu.b4cdd9314e", "Clear Screen")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
