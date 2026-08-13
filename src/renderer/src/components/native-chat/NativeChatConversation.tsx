import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { selectNativeChatViewState } from './native-chat-view-state'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { shouldShowNativeChatWorking } from './native-chat-working-suppression'
import { useNativeChatWorkingInterruption } from './use-native-chat-working-interruption'
import {
  applyCommandMarkerBoundaries,
  commandMarkersAsMessages,
  launchPromptAsMessage,
  pendingSendsAsMessages,
  shouldPruneLaunchPrompt,
  writePendingSendCache
} from './native-chat-pending'
import { useNativeChatPendingState } from './use-native-chat-pending-state'
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
import { resolveNativeChatFileLinkContext } from './native-chat-file-link'
import { selectNativeChatRuntimeEnvironmentId } from './native-chat-runtime-owner'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import type { NativeChatConversationProps } from './native-chat-conversation-types'
export type {
  NativeChatConversationLiveState,
  NativeChatConversationProps
} from './native-chat-conversation-types'

/** Full native conversation surface for an already-resolved agent session. */
export function NativeChatConversation({
  paneKey,
  agent,
  sessionId,
  transcriptPath,
  targetPtyId,
  terminalTabId,
  isVisible = true,
  onSwitchToTerminal,
  readTerminalScreen,
  contextMenuActions,
  ptyWriter,
  attachmentOwner,
  fileLinkContext: providedFileLinkContext,
  fileLinksEnabled = true,
  dictationEnabled,
  sessionOptionsEnabled,
  fileDropEnabled,
  liveState
}: NativeChatConversationProps): React.JSX.Element {
  // Primitive owner selection (no useShallow): routes the pane's read/subscribe to
  // the remote runtime host for a runtime-owned pane; null keeps the local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
  const retainedSession = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const session = useMemo<typeof retainedSession>(() => {
    if (
      !liveState?.working ||
      retainedSession.status === 'working' ||
      retainedSession.status === 'error'
    ) {
      return retainedSession
    }
    return { ...retainedSession, status: 'working' }
  }, [liveState?.working, retainedSession])
  const launchPrompt = useAppStore((s) => s.nativeChatLaunchPromptByTabId[terminalTabId] ?? null)
  const clearNativeChatLaunchPrompt = useAppStore((s) => s.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  // Launch context prefilled into the TUI input as an unsent draft; the
  // composer adopts it so the GUI view shows the same context as the TUI.
  // Shape matches NativeChatComposer's two launch-draft props, so it spreads.
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId,
    agent,
    messages: session.messages,
    transcriptLoading: session.readPhase === 'loading'
  })
  // The live-session merge reconciles hooks with replayable transcript turn
  // boundaries; all working consumers must use that one lifecycle decision.
  const liveWorking = session.status === 'working'
  // The agent's in-progress reply preview (hook), shown as a live streaming
  // bubble while it works — before the completed turn flushes to the transcript.
  const storeHookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  const hookPreview = storeHookPreview ?? liveState?.lastAssistantMessage
  // Why: Stop suppression must clear on a newer working epoch even when status
  // never leaves 'working' (interrupt + immediate next turn coalesced).
  const storeHookWorkingEpoch = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  const hookWorkingEpoch = storeHookWorkingEpoch ?? liveState?.stateStartedAt ?? null
  const canSend = useNativeChatCanSend(targetPtyId)
  // Reuse the verified composer send path for interactive cards and composer
  // stop (Stop sends ESC, the agent-TUI interrupt key).
  const interactiveSend = useNativeChatInteractiveSend(
    terminalTabId,
    paneKey,
    targetPtyId,
    agent,
    ptyWriter,
    liveState?.questionInferenceRequest
  )
  const {
    interrupted: workingInterrupted,
    interruptWorking,
    resumeWorking
  } = useNativeChatWorkingInterruption({
    working: liveWorking,
    paneKey,
    agent,
    sessionId,
    workingEpoch: hookWorkingEpoch,
    messages: session.messages
  })
  // True while a question card owns the input region, so the composer is hidden.
  const [questionActive, setQuestionActive] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // The question card's free-text row; keeps Paste working while the card
  // replaces the composer.
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const storeFileLinkContext = useAppStore(
    useShallow((s) => resolveNativeChatFileLinkContext(s, terminalTabId))
  )
  const fileLinkContext = fileLinksEnabled
    ? (providedFileLinkContext ?? storeFileLinkContext)
    : null
  const pasteClipboardIntoComposer = useNativeChatPasteBridge({
    rootRef,
    composerRef,
    questionAnswerInputRef
  })
  const contextMenu = useNativeChatContextMenu({
    rootRef,
    onSwitchToTerminal,
    showPaneActions: contextMenuActions !== undefined,
    actions: {
      onPaste: pasteClipboardIntoComposer,
      ...(contextMenuActions ?? emptyNativeChatContextMenuActions)
    }
  })

  const {
    commandMarkers,
    onOptimisticSend: appendOptimisticSend,
    onOptimisticSendCanceled,
    onSlashCommand,
    pending,
    pendingScope,
    setPending
  } = useNativeChatPendingState({
    paneKey,
    agent,
    sessionId,
    messages: session.messages
  })
  const onOptimisticSend = useCallback(
    (text: string, imagePaths?: string[]) => {
      resumeWorking()
      return appendOptimisticSend(text, imagePaths)
    },
    [appendOptimisticSend, resumeWorking]
  )
  useEffect(() => {
    if (!paneLaunchPrompt || !shouldPruneLaunchPrompt(paneLaunchPrompt, session.messages)) {
      return
    }
    clearNativeChatLaunchPrompt(terminalTabId)
  }, [clearNativeChatLaunchPrompt, paneLaunchPrompt, session.messages, terminalTabId])
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
  const failedLaunchPromptMessageIds = useMemo(() => {
    const id = paneLaunchPrompt?.failed ? launchPromptMessage?.id : null
    if (!id || !sessionAfterCommandBoundaries.messages.some((message) => message.id === id)) {
      return undefined
    }
    return new Set([id])
  }, [paneLaunchPrompt?.failed, launchPromptMessage?.id, sessionAfterCommandBoundaries.messages])

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
  const isWorking = shouldShowNativeChatWorking({
    isConversation,
    working: liveWorking,
    interrupted: workingInterrupted
  })

  const stopAgent = useCallback((): boolean | Promise<boolean> => {
    const finishAcceptedStop = (): void => {
      interruptWorking()
      // Why: Stop after a submitted turn drops the delayed-write handle once it
      // settles, so cancelPendingSends no longer sees the optimistic id. Clear
      // the echo cache here so a cancelled prompt cannot stick as a ghost bubble.
      setPending(writePendingSendCache(pendingScope, []))
    }
    const accepted = interactiveSend.cancel()
    if (typeof accepted === 'boolean') {
      if (accepted) {
        finishAcceptedStop()
      }
      return accepted
    }
    return accepted.then((delivered) => {
      if (delivered) {
        finishAcceptedStop()
      }
      return delivered
    })
  }, [interactiveSend, interruptWorking, pendingScope, setPending])
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
        messages={sessionAfterCommandBoundaries.messages}
        transcriptSettled={session.readPhase === 'ready'}
        liveInteractivePrompt={liveState?.interactivePrompt}
        liveInteractiveToolName={liveState?.interactiveToolName}
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
          ptyWriter={ptyWriter}
          attachmentOwner={attachmentOwner}
          dictationEnabled={dictationEnabled}
          sessionOptionsEnabled={sessionOptionsEnabled}
          fileDropEnabled={fileDropEnabled}
          agent={agent}
          canSend={canSend}
          isWorking={isWorking}
          onStop={stopAgent}
          onOptimisticSend={onOptimisticSend}
          onOptimisticSendCanceled={onOptimisticSendCanceled}
          onSlashCommand={onSlashCommand}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          {...launchDraftSignal}
        />
      )}
      {contextMenu.menu}
    </div>
  )
}
