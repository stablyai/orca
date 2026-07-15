import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEventHandler,
  type RefObject
} from 'react'
import {
  Clipboard,
  Copy,
  GitFork,
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
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { isMacPlatform, nativeChatToggleShortcutLabel } from './native-chat-shortcut'

type NativeChatContextMenuState = {
  open: boolean
  point: { x: number; y: number }
  selectedText: string
}

type UseNativeChatContextMenuArgs = {
  rootRef: RefObject<HTMLElement | null>
  onSwitchToTerminal?: () => void
  actions: NativeChatContextMenuActions
}

export type NativeChatContextMenuActions = {
  onPaste: () => void
  onSplitRight: () => void
  onSplitDown: () => void
  canEqualizePaneSizes: boolean
  onEqualizePaneSizes: () => void
  canExpandPane: boolean
  isPaneExpanded: boolean
  onToggleExpand: () => void
  onForkAgentSession: () => void
  onSetTitle: () => void
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
  canClosePane: boolean
  onClosePane: () => void
}

/** No-op defaults for when the view has no pane-management actions wired. */
export const emptyNativeChatContextMenuActions: Omit<NativeChatContextMenuActions, 'onPaste'> = {
  onSplitRight: () => {},
  onSplitDown: () => {},
  canEqualizePaneSizes: false,
  onEqualizePaneSizes: () => {},
  canExpandPane: false,
  isPaneExpanded: false,
  onToggleExpand: () => {},
  onForkAgentSession: () => {},
  onSetTitle: () => {},
  onCopyTerminalId: () => {},
  onCopyPaneId: () => {},
  canClosePane: false,
  onClosePane: () => {}
}

export function useNativeChatContextMenu({
  rootRef,
  onSwitchToTerminal,
  actions
}: UseNativeChatContextMenuArgs): {
  onContextMenuCapture: MouseEventHandler<HTMLElement>
  onSelectionCapture: () => void
  menu: React.JSX.Element
} {
  const menuOpenedAtRef = useRef(0)
  const lastSelectedTextRef = useRef('')
  const [state, setState] = useState<NativeChatContextMenuState>({
    open: false,
    point: { x: 0, y: 0 },
    selectedText: ''
  })
  const shortcutLabel = useMemo(() => nativeChatToggleShortcutLabel(isMacPlatform()), [])

  const rememberCurrentSelection = useCallback(() => {
    const selectedText = getNativeChatSelectedText(rootRef.current)
    if (selectedText.trim().length > 0) {
      lastSelectedTextRef.current = selectedText
    }
  }, [rootRef])

  useEffect(() => {
    document.addEventListener('selectionchange', rememberCurrentSelection)
    return () => document.removeEventListener('selectionchange', rememberCurrentSelection)
  }, [rememberCurrentSelection])

  const onContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      menuOpenedAtRef.current = Date.now()
      const selectedText = getNativeChatSelectedText(rootRef.current) || lastSelectedTextRef.current
      setState({
        open: true,
        point: { x: event.clientX, y: event.clientY },
        selectedText
      })
    },
    [rootRef]
  )

  const setOpen = useCallback((open: boolean) => {
    if (!open && Date.now() - menuOpenedAtRef.current < 100) {
      return
    }
    setState((prev) => ({ ...prev, open }))
  }, [])

  return {
    onContextMenuCapture,
    onSelectionCapture: rememberCurrentSelection,
    menu: (
      <DropdownMenu open={state.open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: state.point.x, top: state.point.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className="w-56"
          sideOffset={0}
          align="start"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DropdownMenuItem
            disabled={state.selectedText.trim().length === 0}
            onSelect={() => void window.api.ui.writeClipboardText(state.selectedText)}
          >
            <Copy />
            {translate('auto.components.nativeChat.contextMenu.copy', 'Copy')}
            <DropdownMenuShortcut>{isMacPlatform() ? '⌘C' : 'Ctrl+C'}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.onPaste}>
            <Clipboard />
            {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
          </DropdownMenuItem>
          {onSwitchToTerminal ? (
            <DropdownMenuItem onSelect={onSwitchToTerminal}>
              <SquareTerminal />
              {translate(
                'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                'Switch to terminal view'
              )}
              <DropdownMenuShortcut>{shortcutLabel}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={actions.onForkAgentSession}>
            <GitFork />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a',
              'Fork Agent Session…'
            )}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={actions.onSplitRight}>
            <PanelRightClose />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
              'Split Terminal Right'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.onSplitDown}>
            <PanelBottomClose />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.98bccf4fa2',
              'Split Terminal Down'
            )}
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
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.39809d152f',
              'Set Title…'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.onCopyTerminalId}>
            <Copy />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.copyTerminalId',
              'Copy Terminal ID'
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={actions.onCopyPaneId}>
            <Copy />
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.2cf85a6a55',
              'Copy Pane ID'
            )}
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
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
}

function getNativeChatSelectedText(root: HTMLElement | null): string {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed) {
    return ''
  }
  const anchor = selection.anchorNode
  const focus = selection.focusNode
  if (!nodeBelongsToRoot(anchor, root) || !nodeBelongsToRoot(focus, root)) {
    return ''
  }
  return selection.toString()
}

function nodeBelongsToRoot(node: Node | null, root: HTMLElement): boolean {
  if (!node) {
    return false
  }
  return root.contains(node)
}
