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
  SquareTerminal,
  X
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { shouldIgnoreTerminalMenuPointerDownOutside } from './terminal-context-menu-dismiss'
import type { TerminalQuickCommand } from '../../../../shared/types'

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
  quickCommands: TerminalQuickCommand[]
  onQuickCommand: (command: TerminalQuickCommand) => void
  onToggleExpand: () => void
  onSetTitle: () => void
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
  quickCommands,
  onQuickCommand,
  onToggleExpand,
  onSetTitle
}: TerminalContextMenuProps): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const mod = isMac ? '⌘' : 'Ctrl+'
  const shift = isMac ? '⇧' : 'Shift+'

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
          <DropdownMenuShortcut>{mod}C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste}>
          <Clipboard />
          Paste
          <DropdownMenuShortcut>{mod}V</DropdownMenuShortcut>
        </DropdownMenuItem>
        {quickCommands.length > 0 ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SquareTerminal />
              Quick Commands
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-60">
              {quickCommands.map((command) => (
                <DropdownMenuItem key={command.id} onSelect={() => onQuickCommand(command)}>
                  <span className="truncate">{command.label}</span>
                  {!command.appendEnter ? (
                    <DropdownMenuShortcut className="shrink-0">Insert</DropdownMenuShortcut>
                  ) : null}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSplitRight}>
          <PanelRightClose />
          Split Terminal Right
          {/* Why: on Windows/Linux, Ctrl+D must pass through as EOF (#586),
              so split-right requires Shift on non-Mac platforms. */}
          <DropdownMenuShortcut>{isMac ? `${mod}D` : `${mod}${shift}D`}</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSplitDown}>
          <PanelBottomClose />
          Split Terminal Down
          {/* Why: on Windows/Linux, Alt+Shift+D is used for split-down because
              Ctrl+Shift+D is taken by split-right (#586). */}
          <DropdownMenuShortcut>{isMac ? `${mod}${shift}D` : `Alt+${shift}D`}</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canEqualizePaneSizes && (
          <DropdownMenuItem onSelect={onEqualizePaneSizes}>
            <PanelsTopLeft />
            Equalize Pane Sizes
          </DropdownMenuItem>
        )}
        {canExpandPane && (
          <DropdownMenuItem onSelect={onToggleExpand}>
            {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
            {menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane'}
            <DropdownMenuShortcut>{`${mod}${shift}↩`}</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSetTitle}>
          <Pencil />
          Set Title…
        </DropdownMenuItem>
        {canClosePane && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
              <X />
              Close Pane
              <DropdownMenuShortcut>{mod}W</DropdownMenuShortcut>
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
