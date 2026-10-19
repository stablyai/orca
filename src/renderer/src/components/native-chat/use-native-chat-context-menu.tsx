import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type PointerEventHandler,
  type RefObject
} from 'react'
import { Clipboard, Copy, GitFork, Image as ImageIcon, SquareTerminal } from 'lucide-react'
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
import { NativeChatSelectionQuote } from './NativeChatSelectionQuote'
import { NativeChatPaneMenuItems } from './NativeChatPaneMenuItems'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { TabSplitDirection } from '@/store/slices/tabs'
import { AgentSessionContinuationMenuItem } from '@/components/terminal-pane/AgentSessionContinuationMenuItem'
import { AgentSessionContextCopyMenuItem } from '@/components/terminal-pane/AgentSessionContextCopyMenuItem'
import {
  noNativeChatContextMenuTarget,
  readNativeChatContextMenuTarget,
  type NativeChatContextMenuTarget
} from './native-chat-context-menu-target'
import {
  NativeChatContextMenuTargetItems,
  NativeChatFindMenuItem
} from './NativeChatContextMenuItems'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import type { NativeChatRewindSurface } from './use-native-chat-rewind'

type NativeChatContextMenuState = {
  open: boolean
  point: { x: number; y: number }
  selectedText: string
  canPaste: boolean
  image?: NativeChatCopyImage
  target: NativeChatContextMenuTarget
  returnFocusTo: Element | null
}

type UseNativeChatContextMenuArgs = {
  rootRef: RefObject<HTMLElement | null>
  /** Where a selection from an agent's reply is quoted. */
  composerRef: RefObject<NativeChatComposerHandle | null>
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
} & NativeChatContextMenuTargetArgs

/** What the menu needs to offer the rows for a right-clicked target. */
export type NativeChatContextMenuTargetArgs = {
  /** Answers which text a right-clicked message row copies. */
  messageListRef?: RefObject<Pick<NativeChatMessageListHandle, 'messageCopyText'> | null>
  fileLinkContext?: NativeChatFileLinkContext | null
  /** Where the transcript offers rewind; absent where it never does. */
  rewind?: NativeChatRewindSurface
  onFind?: (returnFocusTo: Element | null) => void
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
  onCopyAgentSessionContext: () => void
  onSetTitle: () => void
  canClearPaneTitle: boolean
  onClearPaneTitle: () => void
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
  onCopyAgentSessionContext: () => {},
  onSetTitle: () => {},
  canClearPaneTitle: false,
  onClearPaneTitle: () => {},
  onCopyTerminalId: () => {},
  onCopyPaneId: () => {},
  canCopyAgentSessionId: false,
  onCopyAgentSessionId: () => {},
  canClosePane: false,
  onClosePane: () => {}
}

export function useNativeChatContextMenu({
  rootRef,
  composerRef,
  enabled = true,
  onSwitchToTerminal,
  actions,
  showTerminalPaneActions = true,
  splitShortcutLabels,
  workspaceLayout,
  resolveOrcaSessionId,
  messageListRef,
  fileLinkContext = null,
  rewind,
  onFind
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
    canPaste: false,
    target: noNativeChatContextMenuTarget,
    returnFocusTo: null
  })
  const shortcutLabel = nativeChatToggleShortcutLabel(isMacPlatform())
  const { image, target } = state
  // Copy, Copy image, Paste and the target rows each show only when they apply to what was right-clicked.
  const hasSelection = state.selectedText.trim().length > 0
  const hasEditItems =
    image !== undefined ||
    hasSelection ||
    state.canPaste ||
    Boolean(target.quoteText ?? target.link ?? target.codeText ?? target.messageText) ||
    (target.rewindItemId !== null && rewind !== undefined)
  const hasSessionItems = onFind !== undefined || showTerminalPaneActions
  const showWorkspaceLayout =
    workspaceLayout !== undefined &&
    canMoveTabToNewPaneColumn(workspaceLayout.unifiedTabId, workspaceLayout.groupId)
  const hasItems =
    hasEditItems || hasSessionItems || showWorkspaceLayout || resolveOrcaSessionId !== undefined

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
        returnFocusTo: rootRef.current?.ownerDocument.activeElement ?? null,
        image: readNativeChatCopyImage(event.target),
        target: readNativeChatContextMenuTarget(event.target, {
          root: rootRef.current,
          composer: composerRef.current,
          messageList: messageListRef?.current ?? null,
          linkContext: fileLinkContext
        })
      })
    },
    [composerRef, enabled, fileLinkContext, messageListRef, rootRef]
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
        {/* Mounted here as the menu root adds no DOM; it steps aside while the menu is open. */}
        <NativeChatSelectionQuote
          rootRef={rootRef}
          composerRef={composerRef}
          enabled={enabled && !(state.open && hasItems)}
        />
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
            // Release captured targets once the menu has faded out.
            setState((prev) => ({
              ...prev,
              image: undefined,
              target: noNativeChatContextMenuTarget,
              returnFocusTo: null
            }))
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
          <NativeChatContextMenuTargetItems
            target={target}
            composerRef={composerRef}
            rewind={rewind}
          />
          {state.canPaste ? (
            <DropdownMenuItem onSelect={actions.onPaste}>
              <Clipboard />
              {translate('auto.components.terminal.pane.TerminalContextMenu.0a917b591a', 'Paste')}
            </DropdownMenuItem>
          ) : null}
          {hasEditItems && hasSessionItems ? <DropdownMenuSeparator /> : null}
          {onFind ? <NativeChatFindMenuItem onSelect={() => onFind(state.returnFocusTo)} /> : null}
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
                <AgentSessionContinuationMenuItem
                  onSelect={actions.onContinueAgentSessionInNewSession}
                />
              ) : null}
              <DropdownMenuItem onSelect={actions.onForkAgentSession}>
                <GitFork />
                {translate(
                  'auto.components.terminal.pane.TerminalContextMenu.8a7ddb8b8a',
                  'Fork Agent Session…'
                )}
              </DropdownMenuItem>
              <AgentSessionContextCopyMenuItem onSelect={actions.onCopyAgentSessionContext} />
            </>
          ) : null}
          {workspaceLayout ? (
            <TabWorkspaceLayoutMenuSection
              unifiedTabId={workspaceLayout.unifiedTabId}
              groupId={workspaceLayout.groupId}
              leadingSeparator={hasEditItems || hasSessionItems}
              shortcutLabels={workspaceLayout.shortcutLabels}
            />
          ) : null}
          {showTerminalPaneActions ? (
            <NativeChatPaneMenuItems actions={actions} splitShortcutLabels={splitShortcutLabels} />
          ) : resolveOrcaSessionId ? (
            <>
              {hasEditItems || hasSessionItems || showWorkspaceLayout ? (
                <DropdownMenuSeparator />
              ) : null}
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
