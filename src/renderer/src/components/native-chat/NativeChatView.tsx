import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { NativeChatSession } from '../../../../shared/native-chat-types'
import { useNativeChatLiveSession } from './use-native-chat-live-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
import {
  applyCommandMarkerBoundaries,
  appendPendingSendCache,
  commandMarkersAsMessages,
  appendCommandMarkerCache,
  launchPromptAsMessage,
  pendingSendsAsMessages,
  nextNativeChatPendingSendId,
  prunePendingSends,
  readCommandMarkerCache,
  readPendingSendCache,
  shouldPruneLaunchPrompt,
  writePendingSendCache,
  type NativeChatCommandMarker,
  type NativeChatPendingSend
} from './native-chat-pending'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../../shared/native-chat-streaming'
import {
  shouldFocusNativeChatComposerFromEditingKey,
  shouldFocusNativeChatPaneFromPointerTarget,
  shouldRedirectNativeChatTyping
} from './native-chat-typing-redirect'
import {
  emptyNativeChatContextMenuActions,
  useNativeChatContextMenu
} from './use-native-chat-context-menu'
import type { NativeChatContextMenuActions } from './use-native-chat-context-menu'
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import type { NativeChatViewProps } from './native-chat-view-types'

export type { NativeChatViewProps } from './native-chat-view-types'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView({
  terminalTabId,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: NativeChatViewProps): React.JSX.Element {
  // Select only this tab's status entry (shallow-compared) so an unrelated
  // pane's status tick doesn't re-render this view or re-run the resolution.
  const agentStatusEntry = useAppStore(
    useShallow((s) =>
      preferredPaneKey
        ? s.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(s.agentStatusByPaneKey, terminalTabId)
    )
  )

  // paneKey: prefer the live entry's key; fall back to the tab id so the hook
  // still has a stable key to select live status by before any pane reports.
  const paneKey = preferredPaneKey ?? agentStatusEntry?.paneKey ?? `${terminalTabId}:`
  return (
    <NativeChatSessionGate
      paneKey={paneKey}
      launchAgent={launchAgent}
      resolvedAgent={resolvedAgent}
      agentStatusEntry={agentStatusEntry}
      ptyId={targetPtyId}
    >
      {(resolution) => (
        <NativeChatResolvedView
          paneKey={resolution.paneKey}
          agent={resolution.agent}
          sessionId={resolution.sessionId}
          transcriptPath={resolution.transcriptPath}
          targetPtyId={targetPtyId}
          terminalTabId={terminalTabId}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          contextMenuActions={contextMenuActions}
        />
      )}
    </NativeChatSessionGate>
  )
}

function NativeChatResolvedView({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  targetPtyId,
  terminalTabId,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions
}: {
  paneKey: string
  agent: NativeChatSession['agent']
  sessionId: string | null
  transcriptPath: string | null
  targetPtyId: string | null
  terminalTabId: string
  onSwitchToTerminal?: () => void
  readTerminalScreen?: () => string | null
  contextMenuActions?: Omit<NativeChatContextMenuActions, 'onPaste'>
}): React.JSX.Element {
  // Primitive owner selection (no useShallow): routes the pane's read/subscribe to
  // the remote runtime host for a runtime-owned pane; null keeps the local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
  const session = useNativeChatLiveSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId
  })
  const launchPrompt = useAppStore((s) => s.nativeChatLaunchPromptByTabId[terminalTabId] ?? null)
  const clearNativeChatLaunchPrompt = useAppStore((s) => s.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  // The live-session merge reconciles hooks with replayable transcript turn
  // boundaries; all working consumers must use that one lifecycle decision.
  const liveWorking = session.status === 'working'
  // The agent's in-progress reply preview (hook), shown as a live streaming
  // bubble while it works — before the completed turn flushes to the transcript.
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
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
  const fileLinkContext = useAppStore(
    useShallow((s) => resolveNativeChatFileLinkContext(s, terminalTabId))
  )
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({
    rootRef,
    composerRef,
    questionAnswerInputRef
  })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    onSwitchToTerminal,
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
  const pendingScope = useMemo(() => ({ paneKey, agent }), [paneKey, agent])
  const [pending, setPending] = useState<NativeChatPendingSend[]>(() =>
    readPendingSendCache(pendingScope)
  )
  // Slash commands aren't chat turns, so they get a small local "Ran /clear"
  // system line instead of a user bubble. Capped + cached per conversation.
  const [commandMarkers, setCommandMarkers] = useState<NativeChatCommandMarker[]>(() =>
    readCommandMarkerCache(commandMarkerScope)
  )
  // Reset the optimistic queue only when the pane/agent changes. A fresh launch
  // often learns its provider session id after the first send; clearing pending
  // on that transition briefly flashes the empty state before the transcript
  // user turn lands.
  useEffect(() => {
    setPending(readPendingSendCache(pendingScope))
    setWorkingInterrupted(false)
  }, [pendingScope])
  // Command markers are session-scoped because slash commands like /clear are
  // local feedback for a specific transcript boundary.
  useEffect(() => {
    setCommandMarkers(readCommandMarkerCache(commandMarkerScope))
    setWorkingInterrupted(false)
  }, [commandMarkerScope])
  // Prune echoes whose real user turn is now in the transcript.
  useEffect(() => {
    setPending((prev) =>
      writePendingSendCache(pendingScope, prunePendingSends(prev, session.messages))
    )
  }, [session.messages, pendingScope])
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      setWorkingInterrupted(false)
      const sentAt = Date.now()
      const boundary = session.messages.at(-1)
      const entry: NativeChatPendingSend = {
        id: nextNativeChatPendingSendId(sentAt),
        text,
        sentAt,
        afterMessageId: boundary?.id ?? null,
        afterMessageTimestamp: boundary?.timestamp ?? null,
        ...(imagePaths ? { imagePaths } : {})
      }
      setPending(appendPendingSendCache(pendingScope, entry))
      return entry.id
    },
    [pendingScope, session.messages]
  )
  const onOptimisticSendCanceled = useCallback(
    (pendingId: string) => {
      // Why: detach/interrupt cancels the delayed Enter, so its optimistic echo
      // must not come back from the pane cache as a prompt that was delivered.
      const next = readPendingSendCache(pendingScope).filter((entry) => entry.id !== pendingId)
      setPending(writePendingSendCache(pendingScope, next))
    },
    [pendingScope]
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
  const launchPromptVisible =
    launchPromptMessage !== null &&
    sessionAfterCommandBoundaries.messages.some((message) => message.id === launchPromptMessage.id)
  const failedLaunchPromptMessageIds = useMemo(() => {
    if (!paneLaunchPrompt?.failed || !launchPromptVisible || !launchPromptMessage) {
      return undefined
    }
    return new Set([launchPromptMessage.id])
  }, [paneLaunchPrompt?.failed, launchPromptMessage, launchPromptVisible])

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
      working: liveWorking
    })
  }, [sessionAfterCommandBoundaries.messages, pendingMessages, hookPreview, liveWorking])
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
    setPending(writePendingSendCache(pendingScope, []))
    interactiveSend.cancel()
  }, [interactiveSend, pendingScope])
  const nativeChatFileLinkClick = useNativeChatFileLinkClick(fileLinkContext)

  // Chat-only font zoom via Cmd/Ctrl +/-/0, gated to the live conversation so
  // the chord is inert on the loading/empty/error states and elsewhere.
  const fontScale = useNativeChatFontScale(isConversation)

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
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
            onLinkClick={nativeChatFileLinkClick}
            allowFileUriLinks={fileLinkContext !== null}
            failedDeliveryMessageIds={failedLaunchPromptMessageIds}
          />
        )}
      </div>
      {/* Live interactive prompt (question / approval) is the bottom input region
          (mobile parity). A question card supplies its own answer input, so it
          fully replaces the composer while active — no stray "Send a message". */}
      <NativeChatInteractiveCard
        paneKey={paneKey}
        send={interactiveSend}
        canSend={canSend}
        onShowingQuestionChange={setQuestionActive}
        answerInputRef={questionAnswerInputRef}
      />
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
          onOptimisticSendCanceled={onOptimisticSendCanceled}
          onSlashCommand={onSlashCommand}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
        />
      )}
      {contextMenu.menu}
    </div>
  )
}
