import {
  Clipboard,
  Copy,
  Eraser,
  Maximize2,
  Minimize2,
  PanelBottomOpen,
  PanelRightOpen,
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
  onClosePane: () => void
  onClearScreen: () => void
  onToggleExpand: () => void
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
  onClosePane,
  onClearScreen,
  onToggleExpand
}: TerminalContextMenuProps): React.JSX.Element {
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
        className="w-48"
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
      >
        <DropdownMenuItem onSelect={onCopy}>
          <Copy />
          Copy
          <DropdownMenuShortcut>⌘C</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onPaste}>
          <Clipboard />
          Paste
          <DropdownMenuShortcut>⌘V</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onSplitRight}>
          <PanelRightOpen />
          Split Right
          <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSplitDown}>
          <PanelBottomOpen />
          Split Down
          <DropdownMenuShortcut>⌘⇧D</DropdownMenuShortcut>
        </DropdownMenuItem>
        {canExpandPane && (
          <DropdownMenuItem onSelect={onToggleExpand}>
            {menuPaneIsExpanded ? <Minimize2 /> : <Maximize2 />}
            {menuPaneIsExpanded ? 'Collapse Pane' : 'Expand Pane'}
            <DropdownMenuShortcut>⌘⇧↩</DropdownMenuShortcut>
          </DropdownMenuItem>
        )}
        {canClosePane && (
          <DropdownMenuItem variant="destructive" onSelect={onClosePane}>
            <X />
            Close Pane
          </DropdownMenuItem>
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
