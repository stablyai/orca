import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { isNativeChatTranscriptUnsettled } from './native-chat-live-session-contract'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { useNativeChatLaunchPromptDeliveryNotice } from './use-native-chat-launch-prompt-delivery-notice'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { useNativeChatInteractivePromptCard } from './use-native-chat-interactive-prompt-card'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatAsyncQuestionsCard } from './NativeChatAsyncQuestionsCard'
import { useNativeChatTerminalAsyncQuestions } from './use-native-chat-terminal-async-questions'
import {
  NATIVE_CHAT_NO_ASYNC_CALLS_FOLDED,
  nativeChatAsyncCallsFolded
} from '../../../../shared/native-chat-async-questions'
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
  const interactiveSend = useNativeChatInteractiveSend(terminalTabId, paneKey, targetPtyId, agent)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  // True while a question card owns the input region, so the composer is hidden.
  const [questionActive, setQuestionActive] = useState(false)
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
  useNativeChatComposerRevealFocus({
    rootRef,
    composerRef,
    isVisible,
    isFocusedGroup,
    composerReady: !questionActive && targetPtyId !== null && canSend
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
    (text: string, imagePaths?: string[], asyncAnswers?: Readonly<Record<string, string>>) => {
      setWorkingInterrupted(false)
      return record(text, imagePaths, asyncAnswers)
    },
    [record]
  )
  const onSlashCommand = useCallback(
    (command: string) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command))
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
  const { model: asyncQuestionsCard, cancelPendingAnswers } = useNativeChatTerminalAsyncQuestions({
    paneKey,
    sessionId,
    agent,
    terminalTabId,
    targetPtyId,
    canSend,
    view: session.asyncQuestions,
    pending,
    messages: session.messages,
    recordOptimistic: onOptimisticSend,
    optimisticOutcome: delivery
  })
  // The phone holding the terminal hides the card for as long as it holds it, so the rows stay.
  const asyncCardAvailable = canSend
  const asyncCallsFolded = useMemo(
    () =>
      asyncCardAvailable && session.asyncQuestions
        ? nativeChatAsyncCallsFolded(session.asyncQuestions)
        : NATIVE_CHAT_NO_ASYNC_CALLS_FOLDED,
    [asyncCardAvailable, session.asyncQuestions]
  )

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
    cancelPendingAnswers()
  }, [interactiveSend, clear, cancelPendingAnswers])
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId, isVisible }
  )

  // Chat-only font zoom via Cmd/Ctrl +/-/0, gated to the live conversation so
  // the chord is inert on the loading/empty/error states and elsewhere.
  const fontScale = useNativeChatFontScale(isConversation)

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
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
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
            session={sessionWithPending}
            isVisible={isVisible}
            isWorking={turnActive}
            expandSignal={false}
            fontScale={fontScale.scale}
            {...turnTiming}
            awaitingInput={awaitingInput}
            onLinkClick={onLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
            deliveryNotices={deliveryNotices}
            asyncCallsFolded={asyncCallsFolded}
          />
        )}
      </div>
      {/* Live interactive prompt (question / approval) is the bottom input region
          (mobile parity). A question card supplies its own answer input, so it
          fully replaces the composer while active — no stray "Send a message". */}
      <NativeChatInteractiveCard
        card={promptCard}
        send={interactiveSend}
        canSend={canSend}
        onShowingQuestionChange={setQuestionActive}
        answerInputRef={questionAnswerInputRef}
      />
      {/* Non-blocking: never inside the blocking card's lifecycle, and the composer stays. */}
      {promptCard === null && asyncCardAvailable ? (
        <NativeChatAsyncQuestionsCard model={asyncQuestionsCard} />
      ) : null}
      {/* canSend reflects the mobile presence-lock: when a mobile client holds
          the pty, the composer shows its guarded state instead of racing the
          mobile driver (R8). */}
      {questionActive ? null : (
        <NativeChatComposer
          ref={composerRef}
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
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft }}
        />
      )}
      {contextMenu.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
