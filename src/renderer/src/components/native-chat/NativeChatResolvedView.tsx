import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { isNativeChatTranscriptUnsettled } from './use-native-chat-live-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatExtensionUiCard } from './NativeChatExtensionUiCard'
import { useNativeChatOmpRpcIntegration } from './use-native-chat-omp-rpc-integration'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
import { shouldPruneLaunchPrompt } from './native-chat-pending'
import { useNativeChatPendingSends } from './use-native-chat-pending-sends'
import {
  appendCommandMarkerCache,
  readCommandMarkerCache,
  type NativeChatCommandMarker,
  type NativeChatCommandMarkerOutcome
} from './native-chat-command-marker'
import { useNativeChatMessageListSession } from './use-native-chat-message-list-session'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatPaneFromPointerTarget,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'
import { resolveEffectiveNativeChatSessionId } from './native-chat-pane-resolution'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { NativeChatOrchestrationPausedNotice } from './NativeChatOrchestrationPausedNotice'
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
  targetPtyId,
  terminalTabId,
  ownsTabWideLaunchDraft,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions,
  orchestrationDispatchStatus
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Primitive owner selection (no useShallow): routes the pane's read/subscribe to
  // the remote runtime host for a runtime-owned pane; null keeps the local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
  const keybindings = useAppStore((s) => s.keybindings)
  const resolvedOmpSessionId = useAppStore(
    (s) => s.ompRpcChatOwnershipByPaneKey[paneKey]?.resolvedSessionId ?? null
  )
  // The id OMP itself published on `session_info_update` — ground truth about
  // which session the owning RPC child is in, so it outranks the on-disk guess.
  const publishedOmpSessionId = useAppStore(
    (s) => s.ompRpcChatOwnershipByPaneKey[paneKey]?.turnState?.sessionInfo?.sessionId ?? null
  )
  const effectiveSessionId = resolveEffectiveNativeChatSessionId(
    sessionId,
    resolvedOmpSessionId,
    publishedOmpSessionId
  )
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId: effectiveSessionId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  // What `session.messages` proves about older history. Deliberately NOT
  // `session.hasMore`, which stays optimistic for the load-earlier affordance
  // and reports true for a window that merely filled its limit (SA-008);
  // `omitsOlderRecords` is the narrower verdict backed by a host measurement,
  // so no consumer may read the oldest row as a horizon without one (SA-007).
  const transcriptWindow = useMemo(
    () => ({
      settled: session.readPhase === 'ready',
      omitsOlderRecords: session.omitsOlderRecords
    }),
    [session.readPhase, session.omitsOlderRecords]
  )
  const ompRpc = useNativeChatOmpRpcIntegration({
    paneKey,
    transcriptMessages: session.messages,
    transcriptWindow,
    hookPreview
  })
  const sessionWithOmpRpcStatus = useMemo<typeof session>(() => {
    if (!ompRpc.statusOverride || session.status === ompRpc.statusOverride) {
      return session
    }
    return { ...session, status: ompRpc.statusOverride }
  }, [session, ompRpc.statusOverride])
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
  // For an RPC-owned pane that decision arrives on the RPC turn stream, so it
  // is read off the RPC-merged status rather than the raw transcript session.
  const liveWorking = sessionWithOmpRpcStatus.status === 'working'
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
    () => ({ paneKey, agent, sessionId: effectiveSessionId }),
    [paneKey, agent, effectiveSessionId]
  )
  const pendingScope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  // The echo queue is pane-owned rather than view-owned: a send outlives this
  // view, and its retraction has to reach whichever view is mounted when the
  // send finally fails.
  const pendingSends = useNativeChatPendingSends({
    scope: pendingScope,
    messages: session.messages
  })
  const pending = pendingSends.pending
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  useEffect(() => {
    setWorkingInterrupted(false)
  }, [pendingScope])
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
  const issuePendingSend = pendingSends.issue
  const clearPendingSends = pendingSends.clearAll
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      return issuePendingSend(text, imagePaths)
    },
    [issuePendingSend]
  )
  // Why: detach/interrupt cancels the delayed Enter, and a failed RPC send
  // never reached the agent, so the echo must not come back from the pane cache
  // as a prompt that was delivered.
  const onOptimisticSendCanceled = pendingSends.retract
  const onSlashCommand = useCallback(
    (command: string, outcome?: NativeChatCommandMarkerOutcome) => {
      setCommandMarkers(appendCommandMarkerCache(commandMarkerScope, command, Date.now(), outcome))
    },
    [commandMarkerScope]
  )

  const { sessionAfterCommandBoundaries, sessionWithPending, failedLaunchPromptMessageIds } =
    useNativeChatMessageListSession({
      session: sessionWithOmpRpcStatus,
      paneLaunchPrompt,
      commandMarkers,
      pending,
      liveWorking,
      hookPreview: ompRpc.effectiveHookPreview,
      hookPreviewIsToolOutput,
      overlayMessages: ompRpc.overlayMessages
    })
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
  const isWorking = shouldShowNativeChatWorking({
    isConversation,
    working: liveWorking,
    interrupted: workingInterrupted
  })

  const stopAgent = useCallback(() => {
    setWorkingInterrupted(true)
    // Why: Stop after a submitted turn drops the delayed-write handle once it
    // settles, so cancelPendingSends no longer sees the optimistic id. Clear
    // the echo cache here so a cancelled prompt cannot stick as a ghost bubble.
    clearPendingSends()
    if (ompRpc.isRpcOwned) {
      void ompRpc.abortChat()
      return
    }
    interactiveSend.cancel()
  }, [clearPendingSends, interactiveSend, ompRpc])
  const nativeChatFileLinkClick = useNativeChatFileLinkClick(fileLinkContext)

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
        // Backspace/Delete outside an input focuses the composer (like typing)
        // but inserts nothing — let the now-focused field handle the keystroke.
        if (shouldFocusNativeChatComposerFromEditingKey(event)) {
          composerRef.current?.focus()
          return
        }
        if (!shouldRedirectNativeChatTyping(event)) {
          return
        }
        if (!composerRef.current?.insertTypedText(event.key)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
      }}
      onMouseUpCapture={contextMenu.onSelectionCapture}
      onKeyUpCapture={contextMenu.onSelectionCapture}
      onContextMenuCapture={contextMenu.onContextMenuCapture}
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
    >
      <NativeChatOrchestrationPausedNotice dispatchStatus={orchestrationDispatchStatus} />
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
            isWorking={isWorking}
            expandSignal={false}
            fontScale={fontScale.scale}
            workingStartedAt={hookWorkingEpoch}
            showTurnStatus={false}
            onLinkClick={nativeChatFileLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
            failedDeliveryMessageIds={failedLaunchPromptMessageIds}
          />
        )}
      </div>
      {/* Live interactive prompt (question / approval) is the bottom input region
          (mobile parity). A question card supplies its own answer input, so it
          fully replaces the composer while active — no stray "Send a message". */}
      {ompRpc.isRpcOwned ? (
        ompRpc.pendingExtensionUiRequest ? (
          <NativeChatExtensionUiCard
            // Why the key: the queue promotes the next request into the same
            // slot, and an input/editor card's draft must not carry over to it.
            key={ompRpc.pendingExtensionUiRequest.id}
            request={ompRpc.pendingExtensionUiRequest}
            onAnswer={ompRpc.answerExtensionUi}
          />
        ) : null
      ) : (
        <NativeChatInteractiveCard
          paneKey={paneKey}
          send={interactiveSend}
          canSend={canSend}
          messages={sessionAfterCommandBoundaries.messages}
          transcriptSettled={session.readPhase === 'ready'}
          onShowingQuestionChange={setQuestionActive}
          answerInputRef={questionAnswerInputRef}
        />
      )}
      {/* canSend reflects the mobile presence-lock: when a mobile client holds
          the pty, the composer shows its guarded state instead of racing the
          mobile driver (R8). */}
      {questionActive || (ompRpc.isRpcOwned && ompRpc.pendingExtensionUiRequest !== null) ? null : (
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
          onOptimisticSendCanceled={onOptimisticSendCanceled}
          onSlashCommand={onSlashCommand}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft }}
          ompRpcChat={{
            isOwned: ompRpc.isRpcOwned,
            isTurnWorking: ompRpc.isRpcTurnWorking,
            send: ompRpc.sendChat,
            onCommandDispatched: ompRpc.onCommandDispatched,
            onCommandAgentInvoked: ompRpc.onCommandAgentInvoked,
            commandFailureMessage: ompRpc.commandFailureMessage,
            commandFailureSuperseded: ompRpc.commandFailureSuperseded,
            commandFailureId: ompRpc.commandFailureId,
            clearCommandFailure: ompRpc.clearCommandFailure,
            reportCommandFailure: ompRpc.reportCommandFailure,
            reportMessageFailure: ompRpc.reportMessageFailure,
            executableCommands: ompRpc.rpcExecutableCommands,
            commands: ompRpc.rpcCommands,
            sessionGeneration: ompRpc.sessionGeneration,
            commandQueueKey: ompRpc.commandQueueKey
          }}
        />
      )}
      {contextMenu.menu}
    </div>
  )
}
