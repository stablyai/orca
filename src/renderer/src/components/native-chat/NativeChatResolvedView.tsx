import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { isNativeChatTranscriptUnsettled } from './native-chat-live-session-contract'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  useNativeChatInteractiveSendReveal,
  useNativeChatRevealLatest
} from './use-native-chat-reveal-latest'
import { useNativeChatLaunchPromptDeliveryNotice } from './use-native-chat-launch-prompt-delivery-notice'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'
import { NativeChatPromptStrip } from './NativeChatPromptCollapse'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { shouldClearNativeChatWorkingSuppression } from './native-chat-working-suppression'
import { resolveNativeChatTerminalTurn } from './native-chat-terminal-turn'
import { useNativeChatTerminalTurnTiming } from './use-native-chat-terminal-turn-timing'
import {
  launchPromptAsMessage,
  pendingSendsAsMessages,
  shouldPruneLaunchPrompt
} from './native-chat-pending'
import { useNativeChatPendingDelivery } from './use-native-chat-pending-delivery'
import {
  appendCommandMarkerCache,
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  readCommandMarkerCache,
  type NativeChatCommandMarker
} from './native-chat-command-marker'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'
import { shouldFocusNativeChatPaneFromPointerTarget } from './native-chat-typing-redirect'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useNativeChatLocalCommandAnswer } from './use-native-chat-local-command-answer'
import { matchNativeChatSplitShortcut } from './native-chat-split-shortcut'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { formatShortcutLabel } from '@/hooks/useShortcutLabel'

/** Renders the bridge UI after NativeChatSessionGate resolves its agent session. */
export function NativeChatResolvedView({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  isVisible,
  isFocusedGroup,
  targetPtyId,
  terminalTabId,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Primitive owner selection (no useShallow): routes the pane's read/subscribe to
  // the remote runtime host for a runtime-owned pane; null keeps the local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
  const keybindings = useAppStore((s) => s.keybindings)
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const launchPrompt = useAppStore((s) => s.nativeChatLaunchPromptByTabId[terminalTabId] ?? null)
  const clearNativeChatLaunchPrompt = useAppStore((s) => s.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  // Launch context prefilled into the TUI input as an unsent draft; the
  // composer adopts it so the GUI view shows the same context as the TUI.
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId,
    agent,
    messages: session.messages,
    // 'awaiting' counts too: adopting a prefill against a transcript that hasn't
    // flushed would re-offer a prompt the user already submitted.
    transcriptLoading: isNativeChatTranscriptUnsettled(session.readPhase)
  })
  // The live-session merge reconciles hooks with replayable transcript turn
  // boundaries; all working consumers must use that one lifecycle decision.
  const liveWorking = session.status === 'working'
  // The agent's in-progress reply preview (hook), shown as a live streaming
  // bubble while it works — before the completed turn flushes to the transcript.
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  // Tool stdout/errors ride the same field for status-card previews; they are not the reply.
  const hookPreviewIsToolOutput = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessageIsToolOutput === true
  )
  // Why: Stop suppression must clear on a newer working epoch even when status
  // never leaves 'working' (interrupt + immediate next turn coalesced).
  const hookWorkingEpoch = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  const canSend = useNativeChatCanSend(targetPtyId)
  // Reuse the verified composer send path for interactive cards and composer
  // stop (Stop sends ESC, the agent-TUI interrupt key).
  const send = useNativeChatInteractiveSend(terminalTabId, paneKey, targetPtyId, agent)
  // Every send this pane makes brings the latest into view, wherever the reader had scrolled.
  const { messageListRef, revealLatest } = useNativeChatRevealLatest()
  const interactiveSend = useNativeChatInteractiveSendReveal(send, targetPtyId, revealLatest)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // The question card's free-text row; keeps Paste working while the card
  // replaces the composer.
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({
    rootRef,
    composerRef,
    questionAnswerInputRef
  })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    onSwitchToTerminal,
    splitShortcutLabels: {
      right: formatShortcutLabel('terminal.splitRight', keybindings),
      down: formatShortcutLabel('terminal.splitDown', keybindings)
    },
    actions: {
      onPaste: pasteClipboardIntoComposer,
      ...(contextMenuActions ?? emptyNativeChatContextMenuActions)
    }
  })

  // Optimistic "queued" sends (mobile parity): a composer send is echoed
  // immediately and pruned once its real user turn lands in the transcript, so
  // the message never vanishes between send and transcript catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const delivery = useNativeChatPendingDelivery({ paneKey, agent, messages: session.messages })
  const { pending, record, clear } = delivery
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }, [commandMarkerScope])
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      return record(text, imagePaths)
    },
    [record]
  )
  const onSlashCommand = useCallback(
    (command: string, output?: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), output))
    },
    [commandMarkerScope]
  )

  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<typeof session>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])

  const sessionAfterCommandBoundaries = useMemo<typeof session>(() => {
    const messages = applyCommandMarkerBoundaries(sessionWithLaunchPrompt.messages, commandMarkers)
    return messages === sessionWithLaunchPrompt.messages
      ? sessionWithLaunchPrompt
      : { ...sessionWithLaunchPrompt, messages }
  }, [sessionWithLaunchPrompt, commandMarkers])
  // Why: answer from the conversation the pane shows, so a `/clear` sent here reads as reset.
  const answerLocally = useNativeChatLocalCommandAnswer(agent, sessionAfterCommandBoundaries)
  const launchPromptDeliveryNotices = useNativeChatLaunchPromptDeliveryNotice(
    paneLaunchPrompt?.failed ? launchPromptMessage?.id : null,
    sessionAfterCommandBoundaries.messages
  )
  // Why memoized: a fresh map each render would re-render every memoized transcript row.
  const deliveryNotices = useMemo(
    () =>
      delivery.notices.size === 0
        ? launchPromptDeliveryNotices
        : new Map([...(launchPromptDeliveryNotices ?? []), ...delivery.notices]),
    [launchPromptDeliveryNotices, delivery.notices]
  )
  const promptCard = useNativeChatInteractivePromptCard({
    paneKey,
    messages: sessionAfterCommandBoundaries.messages,
    transcriptSettled: session.readPhase === 'ready'
  })
  // Why one derived value: an answerable card takes the input region from the composer, which
  // would type into the agent's selector; both are never visible in one commit.
  const promptCardPresentation = useNativeChatPromptCardPresentation({
    paneKey,
    targetPtyId,
    card: promptCard,
    canSend,
    transcriptSettled: session.readPhase === 'ready'
  })
  const shownPromptCard = promptCardPresentation.card
  const collapsedCard = promptCardPresentation.collapsedCard
  const mountedPromptCard = shownPromptCard ?? collapsedCard
  useNativeChatComposerRevealFocus({
    rootRef,
    composerRef,
    isVisible,
    isFocusedGroup,
    composerReady: shownPromptCard === null && targetPtyId !== null && canSend
  })

  // The streaming preview bubble (if any) sits after the transcript but before
  // the optimistic user echoes — same order mobile uses.
  const pendingMessages = useMemo(
    () => pendingSendsAsMessages(pending, sessionAfterCommandBoundaries.messages),
    [pending, sessionAfterCommandBoundaries.messages]
  )
  const streamingText = useMemo(() => {
    return deriveNativeChatStreamingText({
      messages:
        pendingMessages.length > 0
          ? [...sessionAfterCommandBoundaries.messages, ...pendingMessages]
          : sessionAfterCommandBoundaries.messages,
      previewText: hookPreview,
      working: liveWorking,
      previewIsToolOutput: hookPreviewIsToolOutput
    })
  }, [
    sessionAfterCommandBoundaries.messages,
    pendingMessages,
    hookPreview,
    liveWorking,
    hookPreviewIsToolOutput
  ])
  const sessionWithPending = useMemo<typeof session>(() => {
    if (pending.length === 0 && commandMarkers.length === 0 && !streamingText) {
      return sessionAfterCommandBoundaries
    }
    return {
      ...sessionAfterCommandBoundaries,
      messages: [
        ...sessionAfterCommandBoundaries.messages,
        ...commandMarkersAsMessages(commandMarkers),
        ...(streamingText ? [nativeChatStreamingMessage(streamingText)] : []),
        ...pendingMessages
      ]
    }
  }, [sessionAfterCommandBoundaries, pending, pendingMessages, commandMarkers, streamingText])
  // Derive the view state from the pending-augmented session so a send into an
  // otherwise-empty conversation flips to the list (showing the queued bubble)
  // instead of staying on the empty state.
  const viewState = selectNativeChatViewState(sessionWithPending)

  const isConversation = viewState.kind === 'ready'
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: workingInterrupted,
        workingEpoch: hookWorkingEpoch,
        previousWorkingEpoch: previousWorkingEpochRef.current
      })
    ) {
      setWorkingInterrupted(false)
    }
    if (liveWorking && hookWorkingEpoch != null) {
      previousWorkingEpochRef.current = hookWorkingEpoch
    }
    if (!liveWorking) {
      previousWorkingEpochRef.current = null
    }
  }, [liveWorking, workingInterrupted, hookWorkingEpoch])
  const { isWorking, turnActive, awaitingInput } = resolveNativeChatTerminalTurn({
    isConversation,
    working: liveWorking,
    hookAwaitingInput: session.hookAwaitingInput === true,
    interrupted: workingInterrupted,
    hasPromptCard: promptCard !== null
  })
  const turnTiming = useNativeChatTerminalTurnTiming(paneKey, session.messages, turnActive)

  const stopAgent = useCallback(() => {
    setWorkingInterrupted(true)
    // Why: Stop after a submitted turn drops the delayed-write handle once it
    // settles, so cancelPendingSends no longer sees the optimistic id. Clear
    // the echo cache here so a cancelled prompt cannot stick as a ghost bubble.
    clear()
    interactiveSend.cancel()
  }, [interactiveSend, clear])
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId, isVisible }
  )

  // Only the focused conversation accepts chat text-size shortcuts.
  useNativeChatFontSize(isConversation && isVisible && isFocusedGroup, rootRef)
  const appearanceStyle = useNativeChatStoreAppearanceStyle()

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={isWorking ? 'true' : 'false'}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button === 2) {
          contextMenu.onSelectionCapture()
          event.preventDefault()
          event.stopPropagation()
          return
        }
        if (event.button === 0 && shouldFocusNativeChatPaneFromPointerTarget(event.target)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
      onKeyDownCapture={(event) => {
        const splitDirection = event.repeat
          ? null
          : matchNativeChatSplitShortcut(event, getShortcutPlatform(), keybindings)
        if (splitDirection && contextMenuActions) {
          event.preventDefault()
          event.stopPropagation()
          if (splitDirection === 'right') {
            contextMenuActions.onSplitRight()
          } else {
            contextMenuActions.onSplitDown()
          }
          return
        }
        routeNativeChatRootKeyToInput(event, composerRef.current, questionAnswerInputRef.current)
      }}
      onMouseUpCapture={contextMenu.onSelectionCapture}
      onKeyUpCapture={contextMenu.onSelectionCapture}
      onContextMenuCapture={contextMenu.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={agent} />
        ) : (
          <NativeChatMessageList
            ref={messageListRef}
            session={sessionWithPending}
            isVisible={isVisible}
            isWorking={turnActive}
            expandSignal={false}
            {...turnTiming}
            awaitingInput={awaitingInput}
            onLinkClick={onLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
            deliveryNotices={deliveryNotices}
          />
        )}
      </div>
      {/* A collapsed card stays mounted but hidden, so a partly answered question survives. */}
      {mountedPromptCard ? (
        <div hidden={collapsedCard !== null} inert={collapsedCard !== null} className="contents">
          <NativeChatInteractiveCard
            key={promptCardPresentation.occurrenceKey ?? 'prompt'}
            card={mountedPromptCard}
            send={interactiveSend}
            onDismiss={promptCardPresentation.dismiss}
            onCollapse={promptCardPresentation.collapse}
            shouldFocus={shownPromptCard !== null && isVisible && isFocusedGroup}
            answerInputRef={questionAnswerInputRef}
          />
        </div>
      ) : null}
      {collapsedCard ? (
        <NativeChatPromptStrip card={collapsedCard} onExpand={promptCardPresentation.expand} />
      ) : null}
      {/* canSend reflects the mobile presence-lock: when a mobile client holds
          the pty, the composer shows its guarded state instead of racing the
          mobile driver (R8). Under a card it stays mounted but hidden, so its state survives;
          detaching the ref keeps root typing, paste and reveal focus off it. */}
      <div hidden={shownPromptCard !== null} className="contents">
        <NativeChatComposer
          ref={shownPromptCard ? undefined : composerRef}
          inputOwnedByCard={shownPromptCard !== null}
          terminalTabId={terminalTabId}
          paneKey={paneKey}
          targetPtyId={targetPtyId}
          agent={agent}
          canSend={canSend}
          isWorking={isWorking}
          onStop={stopAgent}
          onOptimisticSend={onOptimisticSend}
          onOptimisticSendCanceled={delivery.cancel}
          optimisticSendOutcome={delivery}
          onSlashCommand={onSlashCommand}
          onSubmitted={revealLatest}
          answerCommandLocally={answerLocally}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft }}
        />
      </div>
      {contextMenu.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
