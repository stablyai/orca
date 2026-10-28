import { useNativeChatHandOff } from './use-native-chat-hand-off'
import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from './use-native-chat-store-appearance-style'
import { useRef, useState } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { useStructuredChatLiveSession } from './use-structured-chat-live-session'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import type { NativeChatOptionPickerRequest } from './native-chat-composer-types'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatEmptyPane } from './NativeChatEmptyPane'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatContextClearFade } from './NativeChatContextClearFade'
import { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { selectNativeChatViewState, structuredChatHistoryPhase } from './native-chat-view-state'
import { useNativeChatRootInputRouting } from './use-native-chat-root-input-routing'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { useNativeChatFind } from './use-native-chat-find'
import { NativeChatFindBar } from './NativeChatFindBar'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './use-native-chat-file-link-existence'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { useNativeChatInterruptedContinuation } from './NativeChatInterruptedContinue'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { NativeChatPromptSlotNotices } from './NativeChatComposerNotices'
import { NativeChatInstallSlot, useNativeChatInstallSlot } from './NativeChatInstallSlot'
import { useNativeChatComposerError } from './use-native-chat-composer-notice'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionHostExecution } from './StructuredAgentSessionStatusBridge'
import { useNativeChatRewindHost } from './use-native-chat-rewind-host'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import { chatApprovalFromJournal } from '../../../../shared/native-chat-interactive-prompt'
import { useAppStore } from '../../store'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import { NativeChatStructuredGoalStrip } from './NativeChatStructuredGoalStrip'
import { nativeChatPaneHeader } from './NativeChatPaneHeader'
import { structuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { useNativeChatHostOutage } from './use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from './use-native-chat-host-outage-notice'
import { useNativeChatHostPermissionGate } from './use-native-chat-host-permission-gate'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { useStructuredAgentSessionStartFailureFacts } from './use-structured-agent-session-start-failure-facts'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'
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
  // The host's own word on whether the provider child has answered startup yet.
  const hostExecution = useStructuredAgentSessionHostExecution(props.sessionId, props.target)
  const paneKey = structuredAgentSessionPaneKey(props.tabId, props.sessionId)
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
    hostOptionStamp: hostExecution.optionStamp,
    providerStarting: hostExecution.phase === 'starting',
    // A start's own verdict (a signed-out agent) exists only once that start is proven.
    providerRunning: hostExecution.phase === 'ready',
    rewind: rewindHost,
    transportEnabled: provisionalLaunch.transportEnabled,
    ...(provisionalLaunch.launch ? { launch: provisionalLaunch.launch } : {})
  })
  useRecheckNativeChatFileLinksWhenTurnEnds(controller.isWorking)
  const stopControls = nativeChatStructuredStopControls(controller, hostExecution.stopping)
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId: props.tabId,
    agent: props.agent,
    messages: controller.messages,
    // Pre-read idle/loading states cannot establish a launch draft baseline from an empty transcript.
    transcriptLoading: controller.status === 'idle' || controller.status === 'loading'
  })
  const { composerError, reportComposerError } = useNativeChatComposerError(
    controller.commandRefusalCauses
  )
  const [optionPickerRequest, setOptionPickerRequest] =
    useState<NativeChatOptionPickerRequest | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
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
  const agentLabel = structuredAgentLabel(props.agent)
  const hostPermission = useNativeChatHostPermissionGate(props.target, props.agent, agentLabel)
  const hostHeld = hostPermission.sendBlockedReason !== null
  const submits = useStructuredNativeChatSubmitReveal(controller, provisionalLaunch.retry, hostHeld)
  const promptResponse = useStructuredPromptResponseHold(submits.respond)
  const needsFailureFacts =
    submits.queuedMessages.cards.some((card) => card.state === 'returned') ||
    controller.submissions.some(
      (submission) => submission.dispatchState === 'rejected' && !dispatchWasWithdrawn(submission)
    )
  const startFailures = useStructuredAgentSessionStartFailureFacts(
    controller.journalItems,
    needsFailureFacts || props.agent === 'claude'
  )
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    pending: controller.pending,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    startFailures,
    agentName: agentLabel
  })
  // A lost contact is the host notice's to say; the read adds only a refusal the host sent.
  const readFailure =
    controller.status === 'error' && !(hostOutage && !controller.readRefusal)
      ? structuredAgentSessionReadFailureNotice(controller.readRefusal)
      : null
  // Final read refusal replaces the pane because no existing action can succeed.
  const viewState = selectNativeChatViewState(session, { readRetries: readFailure?.final !== true })
  const paneActive = props.isVisible && props.isFocusedGroup
  useNativeChatFontSize(viewState.kind === 'ready' && paneActive, rootRef)
  const find = useNativeChatFind(paneActive, rootRef, composerRef, submits.messageListRef)
  const appearanceStyle = useNativeChatStoreAppearanceStyle()
  const imageRuntimeContext = useNativeChatImageRuntimeContext(props.tabId)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId: props.sessionId, isVisible: props.isVisible }
  )
  const fileLinkProps = { onLinkClick, allowFileUriLinks: onLinkClick !== undefined }
  const handOff = useNativeChatHandOff({
    pane: props,
    directory: fileLinkContext,
    messages: controller.messages,
    epoch: controller.epoch,
    focusComposer
  })
  const paneCommands = useStructuredNativeChatPaneCommands({
    pane: props,
    handOff,
    ownerWorktreeId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    messageListRef: submits.messageListRef,
    fileLinkContext,
    rewind: controller.rewind.surface,
    onFind: find.open
  })
  const prompt = controller.prompts[0] ?? null
  // Unknown prompts leave the composer usable; a send starts a turn whose cancel can resolve them.
  const promptsUnanswerable = pendingPromptsAllUnanswerableHere(controller.prompts)
  const composerShown = (prompt === null || promptsUnanswerable) && readFailure?.final !== true
  // An owned prompt keeps its card; otherwise a missing program leaves the composer disabled.
  const installLayout = viewState.kind === 'empty' ? 'hero' : 'strip'
  const install = useNativeChatInstallSlot(props, agentLabel, installLayout)
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const cancelPrompt = () => {
    if (prompt && (controller.turnId || props.agent === 'pi')) {
      void controller.cancel(controller.turnId ?? undefined, {
        itemId: prompt.itemId,
        expectedRevision: prompt.revision
      })
    }
  }
  const rootInput = useNativeChatRootInputRouting({
    tabId: props.tabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady: composerShown && install.slot.kind !== 'install'
  })
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const structuredTransport = useNativeChatStructuredComposerTransport({
    props,
    controller,
    sendThroughLaunch: provisionalLaunch.sendThroughLaunch,
    starting: provisionalLaunch.starting,
    transportEnabled: provisionalLaunch.transportEnabled,
    worktreeId: ownerWorktreeId ?? undefined,
    optionPickerRequest,
    setOptionPickerRequest,
    onError: reportComposerError,
    onSubmitted: submits.revealLatest,
    sendBlockedReason: hostPermission.sendBlockedReason ?? install.sendBlockedReason
  })
  const asyncQuestion = { paneKey, session, send: structuredTransport.send }
  const continuation = useNativeChatInterruptedContinuation({
    ...controller,
    target: props.target,
    agent: props.agent,
    sessionId: props.sessionId,
    isWorking: controller.isWorking || hostHeld,
    reportComposerError,
    focusComposer,
    transport: structuredTransport
  })

  // Said once: on the pane when the failure took it, else in the composer's notices.
  const sessionError =
    viewState.kind === 'error' || !readFailure ? controller.error : readFailure.text
  const launch = { ...provisionalLaunch, retry: submits.retryLaunch }
  const availability = useNativeChatAvailabilityNotice({
    unavailable: controller.unavailable,
    agent: props.agent,
    agentLabel,
    launchFailure: provisionalLaunch.lifecycle === 'failed' ? provisionalLaunch.failure : null,
    journalItems: controller.journalItems,
    submissions: controller.submissions,
    deliveryNotices
  })
  const claudeSignIn = useNativeChatClaudeSignIn({
    agent: props.agent,
    target: props.target,
    failure: provisionalLaunch.failure,
    failureRows: startFailures.filter((fact) => isClaudeSignInFailureKind(fact.kind)).length
  })
  // While Install shows, it says what to do; a start failure's "send again" or Retry can't help.
  const notices = structuredSessionNotices({
    launch: install.slot.kind === 'install' ? { ...launch, lifecycle: null } : launch,
    agentLabel,
    sessionError,
    composerError: composerError ?? continuation.continueError,
    claudeSignIn,
    availability,
    hostPermission: hostPermission.notice
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
      onPointerDownCapture={(event) => {
        paneCommands.onPointerDownCapture(event)
        rootInput.onPointerDownCapture(event)
      }}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        paneCommands.onKeyDownCapture(event)
        rootInput.onKeyDownCapture(event)
      }}
      onContextMenuCapture={paneCommands.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      {nativeChatPaneHeader(props, ownerWorktreeId, appearanceStyle.colorScheme, handOff)}
      <NativeChatContextClearFade clearing={controller.contextClear.clearing}>
        {find.isOpen ? <NativeChatFindBar find={find} isVisible={props.isVisible} /> : null}
        {viewState.kind === 'loading' || (viewState.kind === 'error' && !readFailure) ? (
          historyPhase !== 'unread' && <NativeChatLoadingCue />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState
            kind="error"
            retrying={!readFailure?.final}
            {...(readFailure?.named ? { headline: readFailure.text } : {})}
          />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyPane slot={install.slot} agent={props.agent} />
        ) : (
          <NativeChatRewindContext.Provider value={controller.rewind.surface}>
            <NativeChatOrcaStopContext.Provider value={continuation.view}>
              <NativeChatClaudeSignInContext.Provider value={claudeSignIn}>
                <NativeChatMessageList
                  // A rewind or a /clear replaces the conversation; nothing the old one held carries over.
                  key={`${controller.epoch}:${controller.contextClear.clears}`}
                  ref={submits.messageListRef}
                  session={session}
                  journalItems={controller.journalItems}
                  journalSubmissions={controller.submissions}
                  journalLatestTurn={controller.latestTurn}
                  journalHostWork={controller.hostWork}
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
                  {...fileLinkProps}
                  runtimeContext={imageRuntimeContext}
                  deliveryNotices={deliveryNotices}
                />
              </NativeChatClaudeSignInContext.Provider>
            </NativeChatOrcaStopContext.Provider>
          </NativeChatRewindContext.Provider>
        )}
      </NativeChatContextClearFade>
      {readFailure?.final ? null : (
        <>
          {/* Keep queued drafts outside the transcript and above the background-task dock. */}
          <NativeChatQueuedMessageList
            controller={submits.queuedMessages}
            chatWorktreeId={ownerWorktreeId ?? null}
            agentName={agentLabel}
            statedFailures={startFailures}
            steerHeld={stopControls.stopping || hostHeld}
            focusComposer={focusComposer}
            editAttachTo={{ terminalTabId: props.tabId, transport: structuredTransport }}
          />
          <NativeChatStructuredSessionStatus
            sessionId={props.sessionId}
            paneKey={paneKey}
            isVisible={props.isVisible}
            backgroundTasks={controller.backgroundTasks}
            stopBackgroundTask={controller.stopBackgroundTask}
          />
          {prompt ? null : (
            <NativeChatStructuredGoalStrip
              sessionId={props.sessionId}
              threadGoal={controller.threadGoal}
              transport={structuredTransport}
              isWorking={controller.isWorking}
              isVisible={props.isVisible}
              turnId={controller.turnId}
              workingStartedAt={controller.workingStartedAt}
            />
          )}
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
              {...fileLinkProps}
            />
          ) : null}
          {prompt && questionBody ? (
            <NativeChatStructuredQuestionCard
              key={`${prompt.itemId}:${prompt.revision}`}
              questions={agentSessionPromptQuestions(questionBody)}
              onAnswer={(response) => void promptResponse.respond(prompt, response)}
              isSubmitting={promptResponse.holds(prompt)}
              onCancel={cancelPrompt}
              shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
              answerInputRef={questionAnswerInputRef}
            />
          ) : null}
          {prompt ? null : <NativeChatStructuredAsyncQuestion {...asyncQuestion} />}
          {composerShown && <NativeChatInstallSlot slot={install.slot} agentLabel={agentLabel} />}
          {composerShown ? (
            <NativeChatComposer
              ref={composerRef}
              terminalTabId={props.tabId}
              paneKey={paneKey}
              draftScopeKey={structuredAgentSessionDraftScopeKey(props.sessionId)}
              targetPtyId={null}
              agent={props.agent}
              {...stopControls.composer}
              unavailableHint={install.unavailableHint}
              steerQueued={stopControls.stopping ? undefined : submits.queuedMessages.steerNewest}
              structuredTransport={structuredTransport}
              launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft: true }}
              notices={notices}
              recallSource={{ messages: session.messages, withoutImageMarkers: true }}
            />
          ) : null}
        </>
      )}
      {paneCommands.menu}
      {handOff.dialog}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
