import { useNativeChatStructuredPaneNotices } from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import {
  NativeChatCrewFrame,
  NativeChatCrewPanel
} from '@/components/orchestration-crew/NativeChatCrewPanel'
import { NativeChatUsageLimitActionsProvider } from '@/components/native-chat/usage/NativeChatUsageLimitActions'
import { useNativeChatHandOff } from '@/components/native-chat/pane/actions/use-native-chat-hand-off'
import { cn } from '@/lib/class-names'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from '@/components/native-chat/appearance/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '@/components/native-chat/appearance/use-native-chat-store-appearance-style'
import { ImageActionsScope } from '@/components/editor/ImageActions'
import { useRef, useState } from 'react'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useStructuredChatLiveSession } from '@/components/native-chat/session/structured/use-structured-chat-live-session'
import { NativeChatStructuredPromptCard } from '@/components/native-chat/prompts/NativeChatStructuredPromptCard'
import { NativeChatComposer } from '@/components/native-chat/composer/NativeChatComposer'
import type { NativeChatComposerHandle } from '@/components/native-chat/composer/native-chat-composer-types'
import type { NativeChatOptionPickerRequest } from '@/components/native-chat/session/options/controls/native-chat-option-picker-request'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { NativeChatEmptyState } from '@/components/native-chat/host-access/NativeChatEmptyState'
import { NativeChatEmptyPane } from '@/components/native-chat/host-access/NativeChatEmptyPane'
import { NativeChatLoadingCue } from '@/components/native-chat/host-access/NativeChatLoadingCue'
import { NativeChatSubagentTranscripts } from '@/components/native-chat/subagents/NativeChatSubagentTranscripts'
import { useStructuredNativeChatSubagents } from '@/components/native-chat/subagents/use-structured-native-chat-subagents'
import { NativeChatContextClearFade } from '@/components/native-chat/conversation/projection/NativeChatContextClearFade'
import { useStructuredNativeChatSubmitReveal } from '@/components/native-chat/pane/actions/use-structured-native-chat-submit-reveal'
import { useStructuredPromptResponseHold } from '@/components/native-chat/prompts/use-structured-prompt-response-hold'
import { nativeChatStructuredAsyncQuestion } from '@/components/native-chat/prompts/NativeChatStructuredAsyncQuestion'
import {
  selectNativeChatViewState,
  structuredChatHistoryPhase
} from '@/components/native-chat/session/status/native-chat-view-state'
import { useNativeChatRootInputRouting } from '@/components/native-chat/composer/focus/use-native-chat-root-input-routing'
import { useNativeChatFontSize } from '@/components/native-chat/appearance/use-native-chat-font-size'
import { useNativeChatFind } from '@/components/native-chat/viewport/find/use-native-chat-find'
import { NativeChatFindBar } from '@/components/native-chat/viewport/find/NativeChatFindBar'
import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from '@/components/native-chat/links/actions/use-native-chat-link-actions'
import { NativeChatLinkClickContext } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { useNativeChatFileLinkContext } from '@/components/native-chat/links/actions/use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from '@/components/native-chat/links/actions/use-native-chat-file-link-existence'
import { useNativeChatTabOwnerWorktreeId } from '@/components/native-chat/pane/ownership/use-native-chat-tab-owner'
import { useStructuredAgentSession } from '@/components/native-chat/session/structured/use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from '@/components/native-chat/media/images/native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from '@/components/native-chat/pane/actions/use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import { useNativeChatInterruptedContinuation } from '@/components/native-chat/usage/NativeChatInterruptedContinue'
import { NativeChatPromptSlotNotices } from '@/components/native-chat/composer/controls/NativeChatComposerNotices'
import {
  NativeChatInstallSlot,
  useNativeChatInstallSlot
} from '@/components/native-chat/host-access/NativeChatInstallSlot'
import { useNativeChatComposerError } from '@/components/native-chat/composer/controls/use-native-chat-composer-notice'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/host-access/use-native-chat-provisional-launch'
import { useStructuredAgentSessionHostExecution } from '@/components/native-chat/session/status/structured-agent-session-status-hooks'
import { useNativeChatRewindHost } from '@/components/native-chat/messages/actions/use-native-chat-rewind-host'
import { NativeChatRowActionsProvider } from '@/components/native-chat/messages/actions/NativeChatRowActionsProvider'
import { useNativeChatPaneFork } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import { NativeChatQueuedMessageList } from '@/components/native-chat/queue/NativeChatQueuedMessageList'
import {
  cancelStructuredPrompt,
  nativeChatStructuredStopControls
} from '@/components/native-chat/session/structured/writes/native-chat-structured-stop-controls'
import { useAppStore } from '@/store/index'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { useNativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/use-native-chat-structured-composer-transport'
import { NativeChatStructuredComposerTabStrips } from '@/components/native-chat/pane/actions/NativeChatStructuredComposerTabStrips'
import { nativeChatPaneHeader } from '@/components/native-chat/pane/actions/NativeChatPaneHeader'
import { structuredAgentSessionReadFailureNotice } from '@/components/native-chat/messages/notices/structured-agent-session-read-failure-notice'
import { useStructuredAgentSessionDeliveryNotices } from '@/components/native-chat/session/structured/delivery/use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { useNativeChatHostOutage } from '@/components/native-chat/host-access/use-native-chat-host-outage'
import { useNativeChatHostOutageNotice } from '@/components/native-chat/host-access/use-native-chat-host-outage-notice'
import { useNativeChatHostSendGate } from '@/components/native-chat/host-access/use-native-chat-host-send-gate'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/messages/notices/use-structured-agent-session-start-failure-facts'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/agent-session-approval-subject'
import { NativeChatHostSetupContext } from '@/components/native-chat/host-access/native-chat-host-setup'
import {
  NativeChatPartyWorkerApprovalStack,
  NativeChatWorkerApprovalTimeline,
  nativeChatWorkerApprovalParty
} from '@/components/native-chat/worker-approvals/NativeChatWorkerApprovals'

export function NativeChatStructuredSession(props: Omit<NativeChatStructuredViewProps, 'mode'>) {
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(props.tabId)
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(ownerWorktreeId, props.sessionId)
  // The host's own word on whether the provider child has answered startup yet.
  const hostExecution = useStructuredAgentSessionHostExecution(props.sessionId, props.target)
  const paneKey = structuredAgentSessionPaneKey(props.tabId, props.sessionId)
  // Chat-wide preference; an alternate send flips it for one message.
  const queueFollowUps = useAppStore((store) => nativeChatQueueFollowUps(store.settings))
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // Paste target while a question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
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
  const hostSendGate = useNativeChatHostSendGate(props.target, props.agent, hostOutage)
  const hostHeld = hostSendGate.sendBlockedReason !== null
  const submits = useStructuredNativeChatSubmitReveal(controller, provisionalLaunch.retry, hostHeld)
  const workerApprovalParty = nativeChatWorkerApprovalParty(props)
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
    sessionContext: controller,
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
  const subagents = useStructuredNativeChatSubagents({ ...props, paneKey, controller })
  const subagentOpen = subagents.openId !== null
  // A subagent's view takes the composer's place; the main agent's prompts still show.
  const composerShown =
    (prompt === null || promptsUnanswerable) && readFailure?.final !== true && !subagentOpen
  // An owned prompt keeps its card; otherwise a missing program leaves the composer disabled.
  const installLayout = viewState.kind === 'empty' ? 'hero' : 'strip'
  const install = useNativeChatInstallSlot(props, agentLabel, installLayout)
  const canMention = composerShown && install.unavailableHint === undefined
  const cancelPrompt = () => cancelStructuredPrompt(controller, prompt)
  const rootInput = useNativeChatRootInputRouting({
    tabId: props.tabId,
    rootRef,
    composerRef,
    questionAnswerInputRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady: composerShown && install.slot.kind !== 'install',
    surfaceReady: !composerShown || install.slot.kind === 'install'
  })
  const forks = useNativeChatPaneFork(props, controller, ownerWorktreeId)
  const transport = useNativeChatStructuredComposerTransport({
    props,
    controller,
    forks,
    sendThroughLaunch: provisionalLaunch.sendThroughLaunch,
    starting: provisionalLaunch.starting,
    transportEnabled: provisionalLaunch.transportEnabled,
    worktreeId: ownerWorktreeId ?? undefined,
    optionPickerRequest,
    setOptionPickerRequest,
    onError: reportComposerError,
    reveal: submits,
    sendBlockedReason: hostSendGate.sendBlockedReason ?? install.sendBlockedReason
  })
  const continuation = useNativeChatInterruptedContinuation({
    ...controller,
    target: props.target,
    agent: props.agent,
    sessionId: props.sessionId,
    isWorking: controller.isWorking || hostHeld,
    reportComposerError,
    focusComposer,
    transport
  })

  const { setup, notices } = useNativeChatStructuredPaneNotices({
    props,
    ownerWorktreeId,
    provisionalLaunch,
    submits,
    startFailures,
    controller,
    continuation,
    deliveryNotices,
    agentLabel,
    viewState,
    readFailure,
    composerError,
    install,
    hostSendGate,
    hostNotice
  })
  const root = (
    <ImageActionsScope
      enabled={props.isVisible}
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={controller.isWorking ? 'true' : 'false'}
      onPointerDownCapture={(event) => {
        paneCommands.onPointerDownCapture(event)
        rootInput.onPointerDownCapture(event)
      }}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        paneCommands.onKeyDownCapture(event)
        rootInput.onKeyDownCapture(event)
      }}
      onKeyDown={subagents.onKeyDown}
      onContextMenuCapture={paneCommands.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
      data-native-chat-scheme={appearanceStyle.colorScheme}
    >
      {nativeChatPaneHeader(props, ownerWorktreeId, appearanceStyle.colorScheme, handOff)}
      <NativeChatCrewFrame
        panel={<NativeChatCrewPanel {...props} composerRef={composerRef} canMention={canMention} />}
      >
        <NativeChatContextClearFade
          // A read failure stays in view: no divider may come to end the fade.
          clearing={controller.contextClear.clearing && viewState.kind !== 'error'}
          overlay={
            find.isOpen ? <NativeChatFindBar find={find} isVisible={props.isVisible} /> : null
          }
        >
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
            <NativeChatRowActionsProvider pane={props} chat={controller} forks={forks}>
              <NativeChatUsageLimitActionsProvider
                recovery={controller}
                pane={props}
                directory={fileLinkContext}
                messages={controller.messages}
                view={continuation.view}
              >
                <NativeChatHostSetupContext.Provider value={setup}>
                  <NativeChatWorkerApprovalTimeline party={workerApprovalParty}>
                    {(timedRows) => (
                      <NativeChatSubagentTranscripts
                        find={find}
                        // A rewind or a /clear replaces the conversation; nothing the old one held carries over.
                        key={`${controller.epoch}:${controller.contextClear.clears}`}
                        paneKey={paneKey}
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
                        structuredAttachments
                        runtimeContext={imageRuntimeContext}
                        deliveryNotices={deliveryNotices}
                        timedRows={timedRows}
                      />
                    )}
                  </NativeChatWorkerApprovalTimeline>
                </NativeChatHostSetupContext.Provider>
              </NativeChatUsageLimitActionsProvider>
            </NativeChatRowActionsProvider>
          )}
        </NativeChatContextClearFade>
      </NativeChatCrewFrame>
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
            editAttachTo={{ terminalTabId: props.tabId, agent: props.agent, transport }}
          />
          {subagents.strip}
          {/* Workers' open prompts stay pinned here, above this chat's own prompt. */}
          <NativeChatPartyWorkerApprovalStack
            party={workerApprovalParty}
            target={props.target}
            isVisible={props.isVisible}
          />
          {prompt || subagentOpen ? null : (
            <NativeChatStructuredComposerTabStrips
              tabId={props.tabId}
              runtimeContext={imageRuntimeContext}
              threadGoal={controller.threadGoal}
              transport={transport}
              isWorking={controller.isWorking}
              isVisible={props.isVisible}
              turnId={controller.turnId}
              workingStartedAt={controller.workingStartedAt}
            />
          )}
          {composerShown || subagentOpen ? null : <NativeChatPromptSlotNotices notices={notices} />}
          <NativeChatStructuredPromptCard
            key={prompt ? `${prompt.itemId}:${prompt.revision}` : undefined}
            prompt={prompt}
            promptResponse={promptResponse}
            onCancel={cancelPrompt}
            shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
            answerInputRef={questionAnswerInputRef}
          />
          {nativeChatStructuredAsyncQuestion(props, controller, session, transport, submits)}
          {composerShown && <NativeChatInstallSlot install={install} agentLabel={agentLabel} />}
          {subagents.statusBar}
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
              steerHead={stopControls.stopping ? undefined : submits.queuedMessages.steerHead}
              structuredTransport={transport}
              notices={notices}
              recallSource={{ messages: session.messages, withoutImageMarkers: true }}
            />
          ) : null}
        </>
      )}
      {paneCommands.menu}
      {handOff.dialog}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </ImageActionsScope>
  )
  return <NativeChatLinkClickContext value={onLinkClick}>{root}</NativeChatLinkClickContext>
}
