import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useMemo, useRef, useState } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { useStructuredChatLiveSession } from './use-structured-chat-live-session'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'
import { NativeChatMessageList } from './NativeChatMessageList'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { selectNativeChatViewState, structuredChatHistoryPhase } from './native-chat-view-state'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import {
  NativeChatInterruptedContinue,
  useNativeChatInterruptedContinuation
} from './NativeChatInterruptedContinue'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { NativeChatPromptSlotNotices } from './NativeChatComposerNotices'
import { useNativeChatComposerError } from './use-native-chat-composer-notice'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionHostExecution } from './StructuredAgentSessionStatusBridge'
import { useNativeChatRewindHost } from './use-native-chat-rewind-host'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import { chatApprovalFromJournal } from './native-chat-interactive-prompt'
import { useAppStore } from '../../store'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { structuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'
import { useNativeChatHostOutage } from './use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from './use-native-chat-host-outage-notice'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import {
  isClaudeSignInFailureKind,
  NativeChatClaudeSignInContext,
  useNativeChatClaudeSignIn
} from './native-chat-claude-sign-in'

export function NativeChatStructuredSession(
  props: Omit<NativeChatStructuredViewProps, 'mode'>
): React.JSX.Element {
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(props.tabId)
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(ownerWorktreeId, props.sessionId)
  const { sendThroughLaunch } = provisionalLaunch
  // The host's own word on whether the provider child has answered startup yet.
  const hostExecution = useStructuredAgentSessionHostExecution(props.sessionId, props.target)
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(props.tabId, props.sessionId),
    [props.sessionId, props.tabId]
  )
  // Chat-wide: absent means on; only an explicit off keeps mid-turn sends immediate.
  const queueFollowUps = useAppStore((store) => store.settings?.nativeChatQueueFollowUps !== false)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // Paste target while a question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLInputElement>(null)
  const { rewindHost, focusComposer } = useNativeChatRewindHost(props, composerRef)
  const controller = useStructuredAgentSession({
    ...props,
    // Why: Stop and a queued card's Edit give text back to the conversation's draft, as the composer keeps it.
    composerScopeKey: structuredAgentSessionDraftScopeKey(props.sessionId),
    queueFollowUps,
    hostStopping: hostExecution.stopping,
    providerStarting: hostExecution.phase === 'starting',
    rewind: rewindHost,
    transportEnabled: provisionalLaunch.transportEnabled,
    ...(provisionalLaunch.launch ? { launch: provisionalLaunch.launch } : {})
  })
  const stopControls = nativeChatStructuredStopControls(controller, hostExecution.stopping)
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId: props.tabId,
    agent: props.agent,
    messages: controller.messages,
    // Why: the controller starts at `idle`, before any read; like the legacy view's unsettled
    // phases, that empty list must not become the draft's turn baseline.
    transcriptLoading: controller.status === 'idle' || controller.status === 'loading'
  })
  const { composerError, reportComposerError } = useNativeChatComposerError()
  const [optionPickerRequest, setOptionPickerRequest] =
    useState<NativeChatOptionPickerRequest | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const paneCommands = useStructuredNativeChatPaneCommands({
    tabId: props.tabId,
    groupId: props.groupId,
    isVisible: props.isVisible,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    terminalPaneActions: props.contextMenuActions,
    sessionId: props.sessionId,
    target: props.target
  })
  const historyPhase = structuredChatHistoryPhase(provisionalLaunch, controller.status)
  const hostOutage = useNativeChatHostOutage(props.target)
  const hostNotice = useNativeChatHostOutageNotice(hostOutage)
  const session = useStructuredChatLiveSession(
    controller,
    historyPhase,
    props.sessionId,
    props.agent,
    hostOutage === null
  )
  const submits = useStructuredNativeChatSubmitReveal(controller, provisionalLaunch.retry)
  const { revealLatest } = submits
  const promptResponse = useStructuredPromptResponseHold(submits.respond)
  const agentLabel = structuredAgentLabel(props.agent)
  const continuation = useNativeChatInterruptedContinuation({
    target: props.target,
    sessionId: props.sessionId,
    journalItems: controller.journalItems,
    submissions: controller.submissions,
    isWorking: controller.isWorking,
    composer: { clearError: () => reportComposerError(null) }
  })
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    props.agent === 'claude'
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: controller.pending,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    agentName: agentLabel
  })
  // Nothing reads an unread history, so its pane stays blank beside the Retry line.
  const loadingPane = historyPhase === 'unread' ? null : <NativeChatLoadingCue />
  // A lost contact is the host notice's to say; the read adds only a refusal the host sent.
  const readFailure =
    controller.status === 'error' && !(hostOutage && !controller.readRefusal)
      ? structuredAgentSessionReadFailureNotice(controller.readRefusal)
      : null
  // A read no retry gets past (damage, a newer Orca's chat) takes the whole pane, whatever was
  // already on screen: nothing in it can act, and its words say why once.
  const readFailedFinally = readFailure?.final === true
  const viewState = selectNativeChatViewState(session, { readRetries: !readFailedFinally })
  useNativeChatFontSize(
    viewState.kind === 'ready' && props.isVisible && props.isFocusedGroup,
    rootRef
  )
  const appearanceStyle = useNativeChatStoreAppearanceStyle()
  const imageRuntimeContext = useNativeChatImageRuntimeContext(props.tabId)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId: props.sessionId, isVisible: props.isVisible }
  )
  const prompt = controller.prompts[0] ?? null
  // Prompts this build cannot answer leave the composer open: a send starts a turn, whose card
  // cancel then works.
  const promptsUnanswerable = pendingPromptsAllUnanswerableHere(controller.prompts)
  const composerShown = (prompt === null || promptsUnanswerable) && !readFailedFinally
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const cancelPrompt = () => {
    if (prompt && (controller.turnId || props.agent === 'pi')) {
      void controller.cancel(controller.turnId ?? undefined, {
        itemId: prompt.itemId,
        expectedRevision: prompt.revision
      })
    }
  }
  useNativeChatComposerRevealFocus({
    rootRef,
    composerRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady: composerShown
  })
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const questions = questionBody ? agentSessionPromptQuestions(questionBody) : []
  const structuredTransport = useNativeChatStructuredComposerTransport({
    props,
    controller,
    sendThroughLaunch,
    starting: provisionalLaunch.starting,
    worktreeId: ownerWorktreeId ?? undefined,
    optionPickerRequest,
    setOptionPickerRequest,
    onError: reportComposerError,
    onSubmitted: revealLatest,
    queuedMessages: submits.queuedMessages
  })

  // Said once: on the pane when the failure took it, else in the composer's notices.
  const sessionError =
    viewState.kind === 'error' || !readFailure ? controller.error : readFailure.text
  const launch = { ...provisionalLaunch, retry: submits.retryLaunch }
  const claudeSignIn = useNativeChatClaudeSignIn({
    agent: props.agent,
    target: props.target,
    failure: provisionalLaunch.failure,
    failureRows: startFailures.filter((fact) => isClaudeSignInFailureKind(fact.kind)).length
  })
  const notices = structuredSessionNotices({
    launch,
    agentLabel,
    sessionError,
    composerError: composerError ?? continuation.continueError,
    claudeSignIn
  })
  if (hostNotice) {
    notices.push(hostNotice)
  }
  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={controller.isWorking ? 'true' : 'false'}
      tabIndex={-1}
      onPointerDownCapture={paneCommands.onPointerDownCapture}
      onKeyDownCapture={paneCommands.onKeyDownCapture}
      onContextMenuCapture={paneCommands.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' || (viewState.kind === 'error' && !readFailure) ? (
          loadingPane
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState
            kind="error"
            retrying={!readFailure?.final}
            {...(readFailure?.named ? { headline: readFailure.text } : {})}
          />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={props.agent} />
        ) : (
          <NativeChatRewindContext.Provider value={controller.rewind.surface}>
            <NativeChatOrcaStopContext.Provider value={continuation.view}>
              <NativeChatClaudeSignInContext.Provider value={claudeSignIn}>
                <NativeChatMessageList
                  // A rewind replaces the conversation; nothing the old transcript held carries over.
                  key={controller.epoch ?? undefined}
                  ref={submits.messageListRef}
                  session={session}
                  journalItems={controller.journalItems}
                  journalSubmissions={controller.submissions}
                  journalLatestTurn={controller.latestTurn}
                  subagentRoster={controller.subagentRoster}
                  railOutline={controller.railOutline}
                  isVisible={props.isVisible}
                  isWorking={controller.isWorking}
                  expandSignal={false}
                  workingStartedAt={controller.workingStartedAt}
                  settledTurns={controller.settledTurns}
                  awaitingInput={prompt === null ? null : 'shown'}
                  turnActivity={controller.turnActivity}
                  stopping={stopControls.stopping}
                  onLinkClick={onLinkClick}
                  allowFileUriLinks={onLinkClick !== undefined}
                  runtimeContext={imageRuntimeContext}
                  deliveryNotices={deliveryNotices}
                />
              </NativeChatClaudeSignInContext.Provider>
            </NativeChatOrcaStopContext.Provider>
          </NativeChatRewindContext.Provider>
        )}
      </div>
      {readFailedFinally ? null : (
        <>
          <NativeChatInterruptedContinue continuation={continuation} />
          {/* Host-held drafts, never transcript rows. Above the status area, so running shells and agents sit next to the composer. */}
          <NativeChatQueuedMessageList
            controller={submits.queuedMessages}
            steerHeld={stopControls.stopping}
            focusComposer={focusComposer}
          />
          <NativeChatStructuredSessionStatus
            sessionId={props.sessionId}
            paneKey={paneKey}
            isVisible={props.isVisible}
            backgroundTasks={controller.backgroundTasks}
            stopBackgroundTask={controller.stopBackgroundTask}
          />
          {!prompt && controller.threadGoal?.goal ? (
            <NativeChatThreadGoalBanner
              key={props.sessionId}
              goal={controller.threadGoal.goal}
              pending={controller.threadGoal.pending}
              isVisible={props.isVisible}
              runningTurn={
                controller.turnId === null
                  ? null
                  : { startedAt: controller.workingStartedAt ?? null }
              }
              onChange={(change) => void controller.threadGoal?.change(change)}
            />
          ) : null}
          {/* Prompt cards take the composer's slot, below the background-task dock. */}
          {composerShown ? null : <NativeChatPromptSlotNotices notices={notices} />}
          {prompt && approval ? (
            <NativeChatApprovalCard
              key={`${prompt.itemId}:${prompt.revision}`}
              approval={approval}
              onChoose={(optionId) =>
                void promptResponse.respond(prompt, { kind: 'option', optionId })
              }
              isSubmitting={promptResponse.holds(prompt)}
              onCancel={cancelPrompt}
              shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
              onLinkClick={onLinkClick}
              allowFileUriLinks={onLinkClick !== undefined}
            />
          ) : null}
          {prompt && questionBody ? (
            <NativeChatStructuredQuestionCard
              key={`${prompt.itemId}:${prompt.revision}`}
              questions={questions}
              onAnswer={(response) => void promptResponse.respond(prompt, response)}
              isSubmitting={promptResponse.holds(prompt)}
              onCancel={cancelPrompt}
              shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
              answerInputRef={questionAnswerInputRef}
            />
          ) : null}
          {composerShown ? (
            <NativeChatComposer
              ref={composerRef}
              terminalTabId={props.tabId}
              paneKey={paneKey}
              draftScopeKey={structuredAgentSessionDraftScopeKey(props.sessionId)}
              targetPtyId={null}
              agent={props.agent}
              {...stopControls.composer}
              steerQueued={stopControls.stopping ? undefined : submits.queuedMessages.steerNewest}
              structuredTransport={structuredTransport}
              launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft: true }}
              notices={notices}
              recallSource={{ messages: session.messages }}
            />
          ) : null}
        </>
      )}
      {paneCommands.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
