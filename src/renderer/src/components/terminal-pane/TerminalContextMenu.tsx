import {
  Clipboard,
  Copy,
  Eraser,
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
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { AgentIcon } from '@/lib/agent-catalog'

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
  canEqualizePaneSizes: boolean
  onEqualizePaneSizes: () => void
  onClosePane: () => void
  onClearScreen: () => void
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
  canEqualizePaneSizes,
  onEqualizePaneSizes,
  onClosePane,
  onClearScreen,
  repoQuickCommands,
  globalQuickCommands,
  quickCommandRepoLabel,
  onQuickCommand,
  onAddQuickCommand,
  onToggleExpand,
  onSetTitle,
  onCopyPaneId
}: TerminalContextMenuProps): React.JSX.Element {
  const copyShortcut = useShortcutLabel('terminal.copySelection')
  const pasteShortcut = useShortcutLabel('terminal.paste')
  const splitRightShortcut = useShortcutLabel('terminal.splitRight')
  const splitDownShortcut = useShortcutLabel('terminal.splitDown')
  const equalizeShortcut = useShortcutLabel('terminal.equalizePaneSizes')
  const expandShortcut = useShortcutLabel('terminal.expandPane')
  const closeShortcut = useShortcutLabel('terminal.closePane')
  const hasQuickCommands = repoQuickCommands.length > 0 || globalQuickCommands.length > 0
  const showEqualizeShortcut = equalizeShortcut !== 'Unassigned'
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
        <DropdownMenuShortcut className="shrink-0">Insert</DropdownMenuShortcut>
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
          Copy
          <DropdownMenuShortcut>{copyShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste}>
          <Clipboard />
          Paste
          <DropdownMenuShortcut>{pasteShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Play fill="currentColor" strokeWidth={0} />
            Quick Commands
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
                      <DropdownMenuLabel>Global</DropdownMenuLabel>
                    ) : null}
                    {globalQuickCommands.map(renderQuickCommandItem)}
                  </>
                ) : null}
              </>
            ) : (
              <DropdownMenuItem disabled className="text-muted-foreground">
                No quick commands
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
              Add Quick Command…
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSplitRight}>
          <PanelRightClose />
          Split Terminal Right
          <DropdownMenuShortcut>{splitRightShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSplitDown}>
          <PanelBottomClose />
          Split Terminal Down
          <DropdownMenuShortcut>{splitDownShortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canEqualizePaneSizes && (
          <DropdownMenuItem onSelect={onEqualizePaneSizes}>
            <PanelsTopLeft />
            Equalize Pane Sizes
            {showEqualizeShortcut ? (
              <DropdownMenuShortcut>{equalizeShortcut}</DropdownMenuShortcut>
            ) : null}
          </DropdownMenuItem>
        )}
        {canExpandPane && (
          <DropdownMenuItem onSelect={onToggleExpand}>
            {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
            {menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane'}
            <DropdownMenuShortcut>{expandShortcut}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSetTitle}>
          <Pencil />
          Set Title…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyPaneId}>
          <Copy />
          Copy Pane ID
        </DropdownMenuItem>
        {canClosePane && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
              <X />
              Close Pane
              <DropdownMenuShortcut>{closeShortcut}</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onClearScreen}>
          <Eraser />
          Clear Screen
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
