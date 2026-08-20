import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './use-native-chat-retained-session'
import { useNativeChatSessionAugmentation } from './use-native-chat-session-augmentation'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatCanSend } from './use-native-chat-can-send'
import { NativeChatInteractiveCard } from './NativeChatInteractiveCard'
import { useNativeChatStartupRestart } from './use-native-chat-startup-restart'
import { NativeChatStartupNoticeCard } from './NativeChatStartupNoticeCard'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatInteractiveSend } from './use-native-chat-interactive-send'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'
import {
  shouldClearNativeChatWorkingSuppression,
  shouldShowNativeChatWorking
} from './native-chat-working-suppression'
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
import type { NativeChatResolvedViewProps, NativeChatViewProps } from './native-chat-view-types'

export type { NativeChatViewProps } from './native-chat-view-types'

/** Resolves an agent terminal into its native conversation and composer UI. */
export default function NativeChatView({
  terminalTabId,
  isVisible,
  paneKey: preferredPaneKey,
  targetPtyId = null,
  launchAgent,
  resolvedAgent,
  onSwitchToTerminal,
  readTerminalScreen,
  onHoldChatForAgentRestart,
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
          isVisible={isVisible}
          targetPtyId={targetPtyId}
          terminalTabId={terminalTabId}
          onSwitchToTerminal={onSwitchToTerminal}
          readTerminalScreen={readTerminalScreen}
          onHoldChatForAgentRestart={onHoldChatForAgentRestart}
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
  isVisible,
  targetPtyId,
  terminalTabId,
  onSwitchToTerminal,
  readTerminalScreen,
  onHoldChatForAgentRestart,
  contextMenuActions
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Primitive owner selection (no useShallow): routes the pane's read/subscribe to
  // the remote runtime host for a runtime-owned pane; null keeps the local path.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, terminalTabId)
  )
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
  const hookPreview = useAppStore((s) => s.agentStatusByPaneKey[paneKey]?.lastAssistantMessage)
  // Why: Stop suppression must clear on a newer working epoch even when status
  // never leaves 'working' (interrupt + immediate next turn coalesced).
  const hookWorkingEpoch = useAppStore(
    (s) => s.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  const { canSend, lockedReason } = useNativeChatCanSend(targetPtyId, paneKey)
  // Reuse the verified composer send path for interactive cards and composer
  // stop (Stop sends ESC, the agent-TUI interrupt key).
  const interactiveSend = useNativeChatInteractiveSend(terminalTabId, paneKey, targetPtyId, agent)
  // Startup takeover (Codex update prompt/log, trust/hooks-review dialogs, an
  // update-in-progress log, restart handling, …) the chat view otherwise has no way to see —
  // see use-native-chat-startup-restart.ts. `session.messages` (not the pending/
  // command-marker-augmented list below) so a real transcript arrival stops the watch.
  const {
    notice: startupNotice,
    onChoose: onChooseStartupOption,
    onRestart: onRestartCodex
  } = useNativeChatStartupRestart({
    paneKey,
    targetPtyId,
    readTerminalScreen,
    isVisible,
    messageCount: session.messages.length,
    onHoldChatForAgentRestart,
    sendRaw: interactiveSend.sendRaw
  })
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  // True while a question card owns the input region, so the composer is hidden.
  const [questionActive, setQuestionActive] = useState(false)
  // A startup dialog/update-in-progress/dead-agent notice also owns the input region: you
  // cannot chat with a Codex that is blocked on a dialog, updating, or not running.
  const inputRegionOwned = questionActive || startupNotice !== null
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

  // Local-only content layered on top of the transcript: optimistic "queued" send echoes,
  // "Ran /clear" markers, the launch-context draft, and the streaming preview bubble — see
  // use-native-chat-session-augmentation.ts.
  const {
    sessionWithPending,
    sessionAfterCommandBoundariesMessages,
    viewState,
    failedLaunchPromptMessageIds,
    onOptimisticSend,
    onOptimisticSendCanceled,
    onSlashCommand,
    clearPendingSends
  } = useNativeChatSessionAugmentation({
    paneKey,
    agent,
    sessionId,
    session,
    terminalTabId,
    paneLaunchPrompt,
    clearNativeChatLaunchPrompt,
    hookPreview,
    liveWorking,
    setWorkingInterrupted
  })

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
    interactiveSend.cancel()
  }, [interactiveSend, clearPendingSends])
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
          <NativeChatEmptyState kind={startupNotice ? 'starting-agent' : 'empty'} agent={agent} />
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
      {/* Startup takeover (Codex update prompt/log, trust/hooks-review dialogs, an
          update-in-progress log, a required/failed restart, or a dead agent) — see
          use-native-chat-startup-notice.ts + use-native-chat-startup-restart.ts. Rendered
          above the interactive card since it reflects an earlier point in the agent's
          lifecycle (no conversation exists yet). */}
      {startupNotice ? (
        <NativeChatStartupNoticeCard
          notice={startupNotice}
          onChoose={onChooseStartupOption}
          onRestart={onRestartCodex}
          onOpenTerminal={onSwitchToTerminal}
        />
      ) : null}
      {/* Live interactive prompt (question / approval) is the bottom input region
          (mobile parity). A question card supplies its own answer input, so it
          fully replaces the composer while active — no stray "Send a message". */}
      <NativeChatInteractiveCard
        paneKey={paneKey}
        send={interactiveSend}
        canSend={canSend}
        messages={sessionAfterCommandBoundariesMessages}
        transcriptSettled={session.readPhase === 'ready'}
        onShowingQuestionChange={setQuestionActive}
        answerInputRef={questionAnswerInputRef}
      />
      {/* canSend reflects the mobile presence-lock or the agent's foreground evidence
          being gone (see use-native-chat-can-send.ts): either way the composer shows its
          guarded state instead of racing the mobile driver (R8) or typing into a dead
          agent's shell. inputRegionOwned additionally hides the composer while a question
          card OR a startup notice owns the input region. */}
      {inputRegionOwned ? null : (
        <NativeChatComposer
          ref={composerRef}
          terminalTabId={terminalTabId}
          paneKey={paneKey}
          targetPtyId={targetPtyId}
          agent={agent}
          canSend={canSend}
          lockedReason={lockedReason}
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
