import { useAgentStatus } from '@/runtime/agent-status/use-agent-status'
import {
  useNativeChatDeliveryProjection,
  useNativeChatPendingProjection
} from './session/terminal/delivery/use-native-chat-delivery-projection'
import { NativeChatPaneFileDropScope } from './attachments/intake/NativeChatPaneFileDropSurface'
import { NativeChatCrewFrame } from '../orchestration-crew/NativeChatCrewPanel'
import { TerminalChatCrewPanel } from '../orchestration-crew/TerminalChatCrewPanel'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store/index'
import { useNativeChatLaunchDraftSignal } from './drafts/use-native-chat-launch-draft-adoption'
import { useNativeChatRetainedSession } from './session/terminal/read/use-native-chat-retained-session'
import { selectNativeChatViewState } from './session/status/native-chat-view-state'
import { NativeChatChildTranscriptStack } from './NativeChatChildTranscript'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigator
} from './native-chat-child-navigation'
import { NativeChatSubagentTranscripts } from './subagents/NativeChatSubagentTranscripts'
import { closeNativeChatSubagentOnEscape } from './subagents/native-chat-open-subagent'
import {
  useNativeChatInteractiveSendReveal,
  useNativeChatRevealLatest
} from './messages/actions/use-native-chat-reveal-latest'
import { useNativeChatLaunchPromptDeliveryNotice } from './session/terminal/delivery/use-native-chat-launch-prompt-delivery-notice'
import { NativeChatComposer } from './composer/NativeChatComposer'
import { useNativeChatCanSend } from './host-access/use-native-chat-can-send'
import { NativeChatInteractiveCard } from './prompts/NativeChatInteractiveCard'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { nativeChatAskRequiresTerminal } from '../../../../shared/native-chat/native-chat-agent-support'
import { useNativeChatTerminalPromptCard } from './prompts/use-native-chat-interactive-prompt-card'
import { NativeChatPromptStrip } from './prompts/NativeChatPromptCollapse'
import { NativeChatEmptyState } from './host-access/NativeChatEmptyState'
import { useNativeChatInteractiveSend } from './session/terminal/send/use-native-chat-interactive-send'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/transcript/streaming/native-chat-working-suppression'
import { resolveNativeChatTerminalTurn } from '../../../../shared/native-chat/transcript/turns/native-chat-terminal-turn'
import { useNativeChatTerminalTurnTiming } from './conversation/turns/use-native-chat-terminal-turn-timing'
import {
  useNativeChatPendingDelivery,
  useNativeChatOptimisticSend
} from './session/terminal/delivery/use-native-chat-pending-delivery'
import { useNativeChatCommandMarkers } from './session/terminal/delivery/use-native-chat-command-markers'
import { createNativeChatRuntimeSelector } from './pane/ownership/native-chat-runtime-owner'
import type { NativeChatResolvedViewProps } from './native-chat-view-types'
import { useNativeChatSurface, type NativeChatSurfaceArgs } from './use-native-chat-surface'
import { NativeChatSurface, NativeChatSurfaceFindBar } from './NativeChatSurface'
import { runNativeChatTerminalPaneShortcut } from './pane/routing/native-chat-pane-shortcut'
import { useNativeChatFileLinkContext } from './links/actions/use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './links/actions/use-native-chat-file-link-existence'
import { useNativeChatLocalCommandAnswer } from './session/options/terminal/use-native-chat-local-command-answer'
import { useNativeChatImageRuntimeContext } from './media/images/native-chat-image-runtime-context'

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
  readTerminalDraft,
  contextMenuActions
}: NativeChatResolvedViewProps): React.JSX.Element {
  // Route reads/subscriptions through the pane’s runtime owner; null retains local routing.
  const selectOwner = useMemo(() => createNativeChatRuntimeSelector(terminalTabId), [terminalTabId])
  const runtimeEnvironmentId = useAppStore(selectOwner)
  const childNavigator = useNativeChatChildNavigator(
    JSON.stringify([paneKey, runtimeEnvironmentId, sessionId])
  )
  const imageRuntimeContext = useNativeChatImageRuntimeContext(terminalTabId)
  const session = useNativeChatRetainedSession({
    paneKey,
    agent,
    sessionId,
    transcriptPath,
    runtimeEnvironmentId,
    enabled: isVisible
  })
  const launchPrompt = useAppStore((s) => s.nativeChatLaunchPromptByTabId[terminalTabId] ?? null)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  // Adopt the TUI’s unsent launch context into the GUI composer.
  const launchDraftSignal = useNativeChatLaunchDraftSignal({ terminalTabId, agent, session })
  // Use the live session’s reconciled lifecycle for every working-state consumer.
  const liveWorking = session.status === 'working'
  // Preview the in-progress hook reply before its completed transcript turn arrives.
  const hookPreview = useAgentStatus(paneKey)?.lastAssistantMessage
  // Tool stdout/errors ride the same field for status-card previews; they are not the reply.
  const hookPreviewIsToolOutput = useAgentStatus(paneKey)?.lastAssistantMessageIsToolOutput === true
  // A coalesced interrupt/restart can stay working; the newer epoch must still clear Stop suppression.
  const workingEpoch = useAgentStatus(paneKey)?.stateStartedAt ?? null
  const turnEpoch = useAgentStatus(paneKey)?.turnStartedAt ?? null
  const sendWorkingEpoch =
    (session.hookWorking ?? liveWorking) || session.hookAwaitingInput ? turnEpoch : undefined
  const canSend = useNativeChatCanSend(targetPtyId)
  // Share verified composer delivery with prompt answers and ESC-based Stop.
  const send = useNativeChatInteractiveSend(paneKey, targetPtyId, agent)
  const { messageListRef, revealLatest } = useNativeChatRevealLatest()
  const interactiveSend = useNativeChatInteractiveSendReveal(send, targetPtyId, revealLatest)
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const readOnlyComposerRef = useRef<NativeChatComposerHandle>(null)
  const activeComposerRef = childNavigator.child ? readOnlyComposerRef : composerRef
  // Keep Paste targeted while the question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const readOnlyQuestionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const activeQuestionAnswerInputRef = childNavigator.child
    ? readOnlyQuestionAnswerInputRef
    : questionAnswerInputRef
  const fileLinkContext = useNativeChatFileLinkContext(terminalTabId)

  // Keep optimistic echoes until their transcript turns land so sent messages never disappear during catch-up.
  const commandMarkerScope = useMemo(
    () => ({ paneKey, agent, sessionId }),
    [paneKey, agent, sessionId]
  )
  const { clear: clearDelivery, ...delivery } = useNativeChatPendingDelivery({
    paneKey,
    agent,
    session,
    composerRef,
    workingEpoch: sendWorkingEpoch
  })
  const { commandMarkers, onSlashCommand } = useNativeChatCommandMarkers(
    commandMarkerScope,
    setWorkingInterrupted
  )
  const onOptimisticSend = useNativeChatOptimisticSend(delivery.record, setWorkingInterrupted)

  const { launchPromptMessage, sessionAfterCommandBoundaries } = useNativeChatDeliveryProjection(
    paneLaunchPrompt,
    session,
    commandMarkers,
    terminalTabId
  )
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
  const {
    promptCard,
    presentation: promptCardPresentation,
    actionKey
  } = useNativeChatTerminalPromptCard({
    paneKey,
    targetPtyId,
    runtimeEnvironmentId,
    agent,
    sessionId,
    transcriptPath: transcriptPath ?? null,
    messages: sessionAfterCommandBoundaries.messages,
    transcriptSettled: session.readPhase === 'ready',
    canSend
  })
  const { card: shownPromptCard, collapsedCard } = promptCardPresentation
  const mountedPromptCard = shownPromptCard ?? collapsedCard
  const composerReady = shownPromptCard === null && targetPtyId !== null && canSend
  const sessionWithPending = useNativeChatPendingProjection(
    sessionAfterCommandBoundaries,
    delivery.pending,
    commandMarkers,
    sendWorkingEpoch,
    hookPreview,
    liveWorking,
    hookPreviewIsToolOutput
  )
  // Include pending sends when selecting view state so the first echo leaves the empty screen immediately.
  const viewState = selectNativeChatViewState(sessionWithPending)

  const isConversation = viewState.kind === 'ready'
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: workingInterrupted,
        workingEpoch,
        previousWorkingEpoch: previousWorkingEpochRef.current
      })
    ) {
      setWorkingInterrupted(false)
    }
    if (liveWorking && workingEpoch != null) {
      previousWorkingEpochRef.current = workingEpoch
    }
    if (!liveWorking) {
      previousWorkingEpochRef.current = null
    }
  }, [liveWorking, workingInterrupted, workingEpoch])
  const { isWorking, turnActive, awaitingInput } = resolveNativeChatTerminalTurn({
    isConversation,
    working: liveWorking,
    hookAwaitingInput: session.hookAwaitingInput === true,
    interrupted: workingInterrupted,
    hasPromptCard: promptCard !== null
  })
  const turnTiming = useNativeChatTerminalTurnTiming(paneKey, session.messages, turnActive)
  useRecheckNativeChatFileLinksWhenTurnEnds(turnActive)

  const stopAgent = useCallback(() => {
    setWorkingInterrupted(true)
    // Stop can outlive its delayed-write handle; clear cached echoes explicitly to prevent ghost prompts.
    clearDelivery()
    interactiveSend.cancel()
  }, [interactiveSend, clearDelivery])
  const onSplit = useMemo<NativeChatSurfaceArgs['onSplit']>(
    () =>
      contextMenuActions
        ? (shortcut) => runNativeChatTerminalPaneShortcut(shortcut, contextMenuActions)
        : undefined,
    [contextMenuActions]
  )
  const surface = useNativeChatSurface({
    tabId: terminalTabId,
    sessionId,
    isVisible,
    isFocusedGroup,
    composerRef: activeComposerRef,
    questionAnswerInputRef: activeQuestionAnswerInputRef,
    transcriptRef: childNavigator.child ? childNavigator.messageListRef : messageListRef,
    fileLinkContext,
    composerReady: composerReady && childNavigator.child === null,
    surfaceReady: shownPromptCard !== null || childNavigator.child !== null,
    conversationShown: isConversation,
    menu: { onSwitchToTerminal, actions: contextMenuActions },
    onSplit,
    // The terminal under this chat must not take a right-click meant for the chat's menu.
    onPointerDownCapture: (event) => {
      if (event.button === 2) {
        event.stopPropagation()
      }
    },
    onKeyDown: (event) => closeNativeChatSubagentOnEscape(event, paneKey)
  })

  return (
    <NativeChatChildNavigationContext.Provider value={childNavigator.navigation}>
      <NativeChatSurface surface={surface} working={isWorking}>
        <NativeChatSurfaceFindBar surface={surface} isVisible={isVisible} />
        <NativeChatPaneFileDropScope
          enabled={childNavigator.child === null}
          hidden={childNavigator.child !== null}
          inert={childNavigator.child !== null}
          className={childNavigator.child ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        >
          <NativeChatCrewFrame
            panel={
              <TerminalChatCrewPanel
                {...{ terminalTabId, paneKey, targetPtyId, composerRef }}
                isVisible={isVisible && childNavigator.child === null}
                canMention={composerReady && childNavigator.child === null}
              />
            }
          >
            <div className="relative flex min-h-0 flex-1 flex-col">
              {viewState.kind === 'loading' ? (
                <NativeChatEmptyState kind="loading" />
              ) : viewState.kind === 'error' ? (
                <NativeChatEmptyState kind="error" message={viewState.message} />
              ) : viewState.kind === 'empty' ? (
                <NativeChatEmptyState kind="empty" agent={agent} />
              ) : (
                <NativeChatSubagentTranscripts
                  paneKey={paneKey}
                  find={surface.find}
                  ref={messageListRef}
                  session={sessionWithPending}
                  isVisible={isVisible && childNavigator.child === null}
                  isWorking={turnActive}
                  expandSignal={false}
                  {...turnTiming}
                  awaitingInput={awaitingInput}
                  deliveryNotices={deliveryNotices}
                  runtimeContext={imageRuntimeContext}
                />
              )}
            </div>
          </NativeChatCrewFrame>
          {/* A collapsed card stays mounted but hidden, so a partly answered question survives. */}
          {mountedPromptCard ? (
            <div
              hidden={collapsedCard !== null}
              inert={collapsedCard !== null}
              className="contents"
            >
              <NativeChatInteractiveCard
                key={actionKey}
                card={mountedPromptCard}
                send={interactiveSend}
                requiresTerminal={nativeChatAskRequiresTerminal(agent)}
                onAnswerInTerminal={onSwitchToTerminal}
                onDismiss={promptCardPresentation.dismiss}
                onCollapse={
                  mountedPromptCard?.kind === 'approval' && mountedPromptCard.approval.startupDialog
                    ? undefined
                    : promptCardPresentation.collapse
                }
                shouldFocus={
                  shownPromptCard !== null &&
                  isVisible &&
                  isFocusedGroup &&
                  childNavigator.child === null
                }
                answerInputRef={questionAnswerInputRef}
              />
            </div>
          ) : null}
          {collapsedCard ? (
            <NativeChatPromptStrip card={collapsedCard} onExpand={promptCardPresentation.expand} />
          ) : null}
          {/* Honor mobile PTY ownership; retain the hidden composer’s state but detach its ref from typing, paste and focus routes. */}
          <div hidden={shownPromptCard !== null} className="contents">
            <NativeChatComposer
              ref={shownPromptCard ? undefined : composerRef}
              inputOwnedByCard={shownPromptCard !== null}
              {...{ terminalTabId, paneKey, targetPtyId, agent, canSend, isWorking }}
              onStop={stopAgent}
              onOptimisticSend={onOptimisticSend}
              onOptimisticSendCanceled={delivery.cancel}
              optimisticSendOutcome={delivery}
              onSlashCommand={onSlashCommand}
              onSubmitted={revealLatest}
              answerCommandLocally={answerLocally}
              onSwitchToTerminal={onSwitchToTerminal}
              readTerminalScreen={readTerminalScreen}
              launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft, readTerminalDraft }}
              recallSource={{ messages: sessionWithPending.messages, commands: commandMarkers }}
            />
          </div>
        </NativeChatPaneFileDropScope>
        {childNavigator.child ? (
          <NativeChatChildTranscriptStack
            messageListRef={childNavigator.messageListRef}
            path={childNavigator.path}
            onBack={childNavigator.back}
            session={sessionWithPending}
            isVisible={isVisible}
            onLinkClick={surface.onLinkClick}
            runtimeContext={imageRuntimeContext}
          />
        ) : null}
      </NativeChatSurface>
    </NativeChatChildNavigationContext.Provider>
  )
}
