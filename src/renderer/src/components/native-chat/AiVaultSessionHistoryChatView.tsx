import { useMemo, useRef } from 'react'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { isNativeChatTranscriptUnsettled } from './native-chat-live-session-contract'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  useNativeChatMessageListHandle,
  useNativeChatRevealLatest,
  type NativeChatMessageListHandle
} from './use-native-chat-reveal-latest'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { useNativeChatFind } from './use-native-chat-find'
import { NativeChatFindBar } from './NativeChatFindBar'
import type { NativeChatComposerHandle } from './native-chat-composer-types'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'

/**
 * A read-only chat rendering of one Agent Session History row, mounted as its own tab.
 *
 * The live-session hook is the same one a terminal's chat overlay uses — the transport routes
 * by agent (zcode polls its SQLite store through `nativeChat:subscribe`), so no PTY is involved.
 * There is no composer: nothing here can send into a conversation the CLI may still be holding.
 */
export function AiVaultSessionHistoryChatView({
  tabId,
  sessionId,
  agent,
  isVisible,
  isFocusedGroup
}: {
  tabId: string
  sessionId: string
  /** The vault row's agent; only store-reading agents reach this view, typed by the vault list. */
  agent: AiVaultAgent
  isVisible: boolean
  isFocusedGroup: boolean
}): React.JSX.Element {
  const paneKey = useMemo(() => `ai-vault-history-chat:${tabId}`, [tabId])
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    enabled: isVisible
  })
  const { revealLatest } = useNativeChatRevealLatest()
  const messageListRef = useRef<NativeChatMessageListHandle | null>(null)
  useNativeChatMessageListHandle(messageListRef, revealLatest)
  const fontSizeRootRef = useRef<HTMLDivElement>(null)
  useNativeChatFontSize(
    session.readPhase === 'ready' && isVisible && isFocusedGroup,
    fontSizeRootRef
  )
  // No composer in a read-only view; the hook still needs a (never-focused) ref slot.
  const noComposerRef = useRef<NativeChatComposerHandle | null>(null)
  const find = useNativeChatFind(
    isVisible && isFocusedGroup,
    fontSizeRootRef,
    noComposerRef,
    messageListRef
  )
  const appearanceStyle = useNativeChatStoreAppearanceStyle()
  const viewState = selectNativeChatViewState(session)
  const unsettled = isNativeChatTranscriptUnsettled(session.readPhase)
  const agentName = agentLabel(agent)

  return (
    <div
      ref={fontSizeRootRef}
      data-ai-vault-history-chat-root="true"
      tabIndex={-1}
      onKeyDownCapture={(event) => find.onKeyDownCapture(event)}
      className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} flex h-full min-h-0 w-full flex-col`}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      <div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-sidebar-border/60 px-3 text-[11px] text-muted-foreground">
        <span className="truncate">{agentName}</span>
        <span>·</span>
        <span className="truncate font-mono">{sessionId}</span>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {find.isOpen ? <NativeChatFindBar find={find} isVisible={isVisible} /> : null}
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          unsettled ? (
            <NativeChatEmptyState kind="loading" />
          ) : (
            <NativeChatEmptyState kind="empty" agent={agent} />
          )
        ) : (
          <NativeChatMessageList
            ref={messageListRef}
            session={session}
            isVisible={isVisible}
            isWorking={false}
            expandSignal={false}
          />
        )}
      </div>
    </div>
  )
}
