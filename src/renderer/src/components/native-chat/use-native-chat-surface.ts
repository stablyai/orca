import { armKeyLifecycleGuard } from '@/lib/keyboard/key-lifecycle-guard'
import {
  useCallback,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
import { useAppStore } from '@/store'
import type { NativeChatSessionHistoryScope } from './native-chat-session-history-scope'
import { formatShortcutLabel } from '@/lib/keyboard/useShortcutLabel'
import { getShortcutPlatform } from '@/lib/keyboard/shortcut-platform'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import type { NativeChatMessageListHandle } from './messages/actions/use-native-chat-reveal-latest'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu,
  type NativeChatContextMenuActions,
  type UseNativeChatContextMenuArgs
} from './pane/actions/use-native-chat-context-menu'
import { useNativeChatLinkActions } from './links/actions/use-native-chat-link-actions'
import { useNativeChatPasteBridge } from './paste/use-native-chat-paste-bridge'
import { useNativeChatRootInputRouting } from './composer/focus/use-native-chat-root-input-routing'
import { useNativeChatFind } from './viewport/find/use-native-chat-find'
import { useNativeChatFontSize } from './appearance/use-native-chat-font-size'
import { useNativeChatStoreAppearanceStyle } from './appearance/use-native-chat-store-appearance-style'
import {
  matchNativeChatPaneShortcut,
  type NativeChatPaneShortcut
} from './pane/routing/native-chat-pane-shortcut'
import type { NativeChatFileLinkContext } from './links/actions/native-chat-file-link-context'

export type NativeChatSurfaceTranscript = Pick<NativeChatMessageListHandle, 'revealFindMatch'> &
  Partial<Pick<NativeChatMessageListHandle, 'messageCopyText'>>

/** A screen's own context-menu rows; the surface supplies find, paste, and the transcript targets. */
export type NativeChatSurfaceMenu = Omit<
  UseNativeChatContextMenuArgs,
  | 'rootRef'
  | 'composerRef'
  | 'enabled'
  | 'onFind'
  | 'messageListRef'
  | 'splitShortcutLabels'
  | 'actions'
> & { actions?: Partial<Omit<NativeChatContextMenuActions, 'onPaste'>> }

export type NativeChatSurfaceArgs = {
  tabId: string
  /** Scopes the link popover: it closes when the conversation changes. */
  sessionId: string | null
  isVisible: boolean
  isFocusedGroup: boolean
  composerRef: RefObject<NativeChatComposerHandle | null>
  /** A question card's answer field while it replaces the composer. */
  questionAnswerInputRef?: RefObject<HTMLInputElement | HTMLTextAreaElement | null>
  transcriptRef: RefObject<NativeChatSurfaceTranscript | null>
  fileLinkContext: NativeChatFileLinkContext | null
  composerReady: boolean
  surfaceReady?: boolean
  /** Chat zoom keys apply only while a conversation is drawn. */
  conversationShown: boolean
  menu?: NativeChatSurfaceMenu
  /** Runs a split or equalize shortcut; false leaves the key to the rest of the app. */
  onSplit?: (shortcut: NativeChatPaneShortcut) => boolean
  onPointerDownCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void
  /** Bubbling keys the screen handles after its children, e.g. Esc leaving a subagent view. */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void
  /** What the composer's `/resume` opens; a conversation's own history by default. */
  sessionHistory?: NativeChatSessionHistoryScope
}

/** Everything a chat screen's root owns, identical for every chat: find, links, context menu,
 *  typing and paste into the composer, zoom keys, split keys, and the chat's appearance. */
export function useNativeChatSurface({
  tabId,
  sessionId,
  isVisible,
  isFocusedGroup,
  composerRef,
  questionAnswerInputRef: answerInputRef,
  transcriptRef,
  fileLinkContext,
  composerReady,
  surfaceReady,
  conversationShown,
  menu: { actions: screenActions, ...screenMenu } = {},
  onSplit,
  onPointerDownCapture: screenPointerDownCapture,
  onKeyDown,
  sessionHistory = 'conversation'
}: NativeChatSurfaceArgs) {
  const rootRef = useRef<HTMLDivElement>(null)
  const noAnswerInputRef = useRef<HTMLInputElement>(null)
  const questionAnswerInputRef = answerInputRef ?? noAnswerInputRef
  const active = isVisible && isFocusedGroup
  const keybindings = useAppStore((state) => state.keybindings)
  const appearance = useNativeChatStoreAppearanceStyle()
  useNativeChatFontSize(conversationShown && active, rootRef)
  const find = useNativeChatFind(active, rootRef, composerRef, transcriptRef)
  const { onLinkClick, linkActionRequest, requestLinkActions, closeLinkActions } =
    useNativeChatLinkActions(fileLinkContext, rootRef, { sessionId, isVisible })
  const rootInput = useNativeChatRootInputRouting({
    tabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible,
    isFocusedGroup,
    composerReady,
    surfaceReady
  })
  const onPaste = useNativeChatPasteBridge({ rootRef, composerRef, questionAnswerInputRef })
  const contextMenu = useNativeChatContextMenu({
    fileLinkContext,
    ...screenMenu,
    rootRef,
    composerRef,
    enabled: isVisible,
    actions: { ...emptyNativeChatContextMenuActions, ...screenActions, onPaste },
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    messageListRef: transcriptRef,
    onFind: find.open
  })
  const onSplitKey = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const shortcut =
        onSplit && !event.repeat
          ? matchNativeChatPaneShortcut(event, getShortcutPlatform(), keybindings)
          : null
      if (shortcut && onSplit?.(shortcut)) {
        event.preventDefault()
        event.stopPropagation()
        if (shortcut === 'moveToNewTab') {
          // Focus lands in the new tab before this chord's release.
          armKeyLifecycleGuard(event.nativeEvent)
        }
      }
    },
    [keybindings, onSplit]
  )
  const rootProps = {
    onPointerDownCapture: (event: ReactPointerEvent<HTMLDivElement>) => {
      contextMenu.onPointerDownCapture(event)
      screenPointerDownCapture?.(event)
      rootInput.onPointerDownCapture(event)
    },
    onKeyDownCapture: (event: ReactKeyboardEvent<HTMLDivElement>) => {
      find.onKeyDownCapture(event)
      onSplitKey(event)
      rootInput.onKeyDownCapture(event)
    },
    onKeyDown,
    onContextMenuCapture: contextMenu.onContextMenuCapture
  }
  return {
    rootRef,
    rootProps,
    appearance,
    find,
    onLinkClick,

    requestLinkActions,
    linkActionRequest,
    closeLinkActions,
    menu: contextMenu.menu,
    sessionHistory
  }
}

export type NativeChatSurfaceState = ReturnType<typeof useNativeChatSurface>
