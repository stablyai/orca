import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject
} from 'react'
import {
  Clipboard,
  Copy,
  GitFork,
  Image as ImageIcon,
  Maximize2,
  MessageSquarePlus,
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
import {
  copyNativeChatImage,
  readNativeChatCopyImage,
  type NativeChatCopyImage
} from './native-chat-image-copy'
import { isMacPlatform, nativeChatToggleShortcutLabel } from './native-chat-shortcut'
import { TabWorkspaceLayoutMenuSection } from '@/components/tab-bar/TabWorkspaceLayoutMenuSection'
import { canMoveTabToNewPaneColumn } from '@/components/tab-bar/tab-move-to-pane-column'
import { isEditableTarget } from '@/lib/editable-target'
import { NativeChatCopyOrcaSessionIdMenuItem } from './NativeChatCopyOrcaSessionIdMenuItem'
import type { TabSplitDirection } from '@/store/slices/tabs'

type NativeChatContextMenuState = {
  open: boolean
  point: { x: number; y: number }
  selectedText: string
  canPaste: boolean
  image?: NativeChatCopyImage
}

type UseNativeChatContextMenuArgs = {
  rootRef: RefObject<HTMLElement | null>
  enabled?: boolean
  /** Bridge-only escape hatch; structured sessions have no terminal view. */
  onSwitchToTerminal?: () => void
  actions: NativeChatContextMenuActions
  showTerminalPaneActions?: boolean
  splitShortcutLabels?: { right: string; down: string }
  workspaceLayout?: {
    unifiedTabId: string
    groupId: string
    shortcutLabels?: Partial<Record<TabSplitDirection, string>>
  }
  /** A structured chat tab's Orca session ID; a chat in a terminal pane is that terminal's agent. */
  resolveOrcaSessionId?: () => Promise<string | null>
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
  canContinueAgentSessionInNewSession: boolean
  onContinueAgentSessionInNewSession: () => void
  onForkAgentSession: () => void
  onSetTitle: () => void
  onCopyTerminalId: () => void
  onCopyPaneId: () => void
  canCopyAgentSessionId: boolean
  onCopyAgentSessionId: () => void
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
  canContinueAgentSessionInNewSession: false,
  onContinueAgentSessionInNewSession: () => {},
  onForkAgentSession: () => {},
  onSetTitle: () => {},
  onCopyTerminalId: () => {},
  onCopyPaneId: () => {},
  canCopyAgentSessionId: false,
  onCopyAgentSessionId: () => {},
  canClosePane: false,
  onClosePane: () => {}
}

export function useNativeChatContextMenu({
  rootRef,
  enabled = true,
  onSwitchToTerminal,
  actions,
  showTerminalPaneActions = true,
  splitShortcutLabels,
  workspaceLayout,
  resolveOrcaSessionId
}: UseNativeChatContextMenuArgs): {
  onContextMenuCapture: MouseEventHandler<HTMLElement>
  onPointerDownCapture: PointerEventHandler<HTMLElement>
  menu: React.JSX.Element
} {
  const menuOpenedAtRef = useRef(0)
  const [state, setState] = useState<NativeChatContextMenuState>({
    open: false,
    point: { x: 0, y: 0 },
    selectedText: '',
    canPaste: false
  })
  const shortcutLabel = nativeChatToggleShortcutLabel(isMacPlatform())
  const { image } = state
  // Copy, Copy image and Paste each show only when they apply to what was right-clicked.
  const hasSelection = state.selectedText.trim().length > 0
  const hasEditItems = image !== undefined || hasSelection || state.canPaste
  const showWorkspaceLayout =
    workspaceLayout !== undefined &&
    canMoveTabToNewPaneColumn(workspaceLayout.unifiedTabId, workspaceLayout.groupId)
  const hasItems =
    hasEditItems ||
    showTerminalPaneActions ||
    showWorkspaceLayout ||
    resolveOrcaSessionId !== undefined

  useEffect(() => {
    if (!enabled) {
      setState((current) =>
        current.open ? { ...current, open: false, image: undefined } : current
      )
    }
  }, [enabled])

  const onContextMenuCapture = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault()
      event.stopPropagation()
      if (!enabled) {
        return
      }
      menuOpenedAtRef.current = Date.now()
      setState({
        open: true,
        point: { x: event.clientX, y: event.clientY },
        selectedText: getNativeChatSelectedText(rootRef.current),
        canPaste: isEditableTarget(event.target),
        image: readNativeChatCopyImage(event.target)
      })
    },
    [enabled, rootRef]
  )

  const setOpen = useCallback((open: boolean) => {
    if (!open && Date.now() - menuOpenedAtRef.current < 100) {
      return
    }
    setState((prev) => ({ ...prev, open }))
  }, [])

  return {
    onContextMenuCapture,
    onPointerDownCapture: keepSelectionThroughMenuPress,
    menu: (
      <DropdownMenu open={enabled && state.open && hasItems} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: state.point.x, top: state.point.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          data-native-chat-context-menu=""
          className="w-56"
          sideOffset={0}
          align="start"
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            // Drop the read image once the menu has faded out, so a large file isn't held.
            setState((prev) => ({ ...prev, image: undefined }))
          }}
        >
          {image ? (
            <DropdownMenuItem onSelect={() => void copyNativeChatImage(image)}>
              <ImageIcon />
              {translate('components.native-chat.composer.copyImage', 'Copy image')}
            </DropdownMenuItem>
          ) : null}
          {hasSelection ? (
            <DropdownMenuItem
              onSelect={() => void window.api.ui.writeClipboardText(state.selectedText)}
            >
              <Copy />
              {translate('auto.components.nativeChat.contextMenu.copy', 'Copy')}
              <DropdownMenuShortcut>{isMacPlatform() ? '⌘C' : 'Ctrl+C'}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ) : null}
          {state.canPaste ? (
            <DropdownMenuItem onSelect={actions.onPaste}>
              <Clipboard />
              {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
            </DropdownMenuItem>
          ) : null}
          {showTerminalPaneActions ? (
            <>
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
              {actions.canContinueAgentSessionInNewSession ? (
                <DropdownMenuItem onSelect={actions.onContinueAgentSessionInNewSession}>
                  <MessageSquarePlus />
                  {translate(
                    'components.agentSessionContinuation.continueInNewSession',
                    'Continue in New Session…'
                  )}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={actions.onForkAgentSession}>
                <GitFork />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a',
                  'Fork Agent Session…'
                )}
              </DropdownMenuItem>
            </>
          ) : null}
          {workspaceLayout ? (
            <TabWorkspaceLayoutMenuSection
              unifiedTabId={workspaceLayout.unifiedTabId}
              groupId={workspaceLayout.groupId}
              leadingSeparator={hasEditItems}
              shortcutLabels={workspaceLayout.shortcutLabels}
            />
          ) : null}
          {showTerminalPaneActions ? (
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
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.39809d152f',
                  'Set Title…'
                )}
              </DropdownMenuItem>
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
            </>
          ) : resolveOrcaSessionId ? (
            <>
              {hasEditItems || showWorkspaceLayout ? <DropdownMenuSeparator /> : null}
              <NativeChatCopyOrcaSessionIdMenuItem resolveOrcaSessionId={resolveOrcaSessionId} />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
}

function keepSelectionThroughMenuPress(event: React.PointerEvent<HTMLElement>): void {
  // Why: left alone, the press that opens the menu collapses the selection before contextmenu fires.
  if (event.button === 2 || (isMacPlatform() && event.ctrlKey)) {
    event.preventDefault()
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
