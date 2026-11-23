import { useBotLinkPrompt } from '@/lib/agent-session/open/bot-link-item-target'
import {
  NativeChatCrewContext,
  useNativeChatCrewSource
} from '../orchestration-crew/use-native-chat-crew'
import { NativeChatUsageLimitActionsProvider } from './usage/NativeChatUsageLimitActions'
import { useNativeChatHandOff } from './pane/actions/use-native-chat-hand-off'
import { useNativeChatStructuredPaneNotices } from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import { useRef, useState } from 'react'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useStructuredChatLiveSession } from './session/structured/use-structured-chat-live-session'
import { NativeChatStructuredPromptCard } from './prompts/NativeChatStructuredPromptCard'
import { NativeChatComposer } from './composer/NativeChatComposer'
import { NativeChatEmptyState } from './host-access/NativeChatEmptyState'
import { NativeChatEmptyPane } from './host-access/NativeChatEmptyPane'
import { NativeChatLoadingCue } from './host-access/NativeChatLoadingCue'
import { NativeChatSubagentTranscripts } from './subagents/NativeChatSubagentTranscripts'
import { useStructuredNativeChatSubagents } from './subagents/use-structured-native-chat-subagents'
import { NativeChatContextClearFade } from './conversation/projection/NativeChatContextClearFade'
import { useStructuredNativeChatSubmitReveal } from './pane/actions/use-structured-native-chat-submit-reveal'
import { useStructuredPromptResponseHold } from './prompts/use-structured-prompt-response-hold'
import { nativeChatStructuredQuestions } from './prompts/NativeChatStructuredAsyncQuestion'
import {
  selectNativeChatViewState,
  structuredChatHistoryPhase
} from './session/status/native-chat-view-state'
import type { NativeChatOptionPickerRequest } from '@/components/native-chat/session/options/controls/native-chat-option-picker-request'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import { useNativeChatFileLinkContext } from './links/actions/use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './links/actions/use-native-chat-file-link-existence'
import { useBotChatOwner } from '../bots/use-bot-chat-identity'
import {
  NativeChatSlackMirrorContext,
  useNativeChatSlackMirror
} from './slack-mirror/native-chat-slack-mirror'
import { useStructuredAgentSession } from './session/structured/use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from './media/images/native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './pane/actions/use-structured-native-chat-pane-commands'
import { useNativeChatSurface } from './use-native-chat-surface'
import { NativeChatSurface, NativeChatSurfaceFindBar } from './NativeChatSurface'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { useNativeChatInterruptedContinuation } from './usage/NativeChatInterruptedContinue'
import { NativeChatPromptSlotNotices } from './composer/controls/NativeChatComposerNotices'
import { NativeChatAntigravityAuthProvider } from './antigravity-auth/native-chat-antigravity-auth'
import {
  NativeChatInstallSlot,
  useNativeChatInstallSlot
} from './host-access/NativeChatInstallSlot'
import { useNativeChatComposerError } from './composer/controls/use-native-chat-composer-notice'
import { useNativeChatProvisionalLaunch } from './host-access/use-native-chat-provisional-launch'
import { useNativeChatRewindHost } from './messages/actions/use-native-chat-rewind-host'
import { NativeChatRowActionsProvider } from './messages/actions/NativeChatRowActionsProvider'
import { NativeChatQueuedMessageList } from './queue/NativeChatQueuedMessageList'
import { cancelStructuredPrompt } from './session/structured/writes/native-chat-structured-stop-controls'
import { useNativeChatBotHome } from './NativeChatBotHomeScope'
import { useStructuredAgentSessionHostExecution } from '@/components/native-chat/session/status/structured-agent-session-status-hooks'
import { useNativeChatPaneFork } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import { NativeChatDock, NativeChatDockTranscript } from './pane/dock/NativeChatDock'
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
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { BotServerOutageCard } from '@/components/bots/BotServerOutageCard'
import { useNativeChatHostSendGate } from '@/components/native-chat/host-access/use-native-chat-host-send-gate'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/messages/notices/use-structured-agent-session-start-failure-facts'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { NativeChatHostSetupContext } from '@/components/native-chat/host-access/native-chat-host-setup'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import { nativeChatWorkerApprovalParty } from './worker-approvals/NativeChatWorkerApprovals'
import { NativeChatWorkerTimeline } from './tools/tasks/dock/NativeChatWorkerResultTimeline'

export function NativeChatStructuredSession(props: Omit<NativeChatStructuredViewProps, 'mode'>) {
  const { ownerWorktreeId, turnBot, bot: chatBot } = useBotChatOwner(props)
  const slackMirror = useNativeChatSlackMirror(chatBot, props.sessionId)
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
  const { composerError, reportComposerError } = useNativeChatComposerError(
    controller.commandRefusalCauses
  )
  const [optionPickerRequest, setOptionPickerRequest] =
    useState<NativeChatOptionPickerRequest | null>(null)
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
  const imageRuntimeContext = useNativeChatImageRuntimeContext(props.tabId)
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
    composerRef,
    rewind: controller.rewind.surface
  })
  const prompt = useBotLinkPrompt(props.sessionId, controller.prompts)
  // Unknown prompts leave the composer usable; a send starts a turn whose cancel can resolve them.
  const promptsUnanswerable = pendingPromptsAllUnanswerableHere(controller.prompts)
  // A bot's page whose server is down keeps its last read; the recovery card stands in for the composer.
  const pageBot = useBotForWorkspace(ownerWorktreeId ?? null)
  const botServerDown = pageBot !== null && hostOutage !== null && hostOutage.kind !== 'stopped'
  const subagents = useStructuredNativeChatSubagents({ ...props, paneKey, controller })
  const subagentOpen = subagents.openId !== null
  // A subagent's view takes the composer's place; the main agent's prompts still show.
  const composerShown =
    (prompt === null || promptsUnanswerable) &&
    readFailure?.final !== true &&
    !botServerDown &&
    !subagentOpen
  // An owned prompt keeps its card; otherwise a missing program leaves the composer disabled.
  const installLayout = viewState.kind === 'empty' ? 'hero' : 'strip'
  const install = useNativeChatInstallSlot(props, agentLabel, installLayout)
  const canMention = composerShown && install.unavailableHint === undefined
  const crew = useNativeChatCrewSource({
    target: props.target,
    sessionId: props.sessionId,
    isVisible: props.isVisible,
    composerRef,
    canMention
  })
  const cancelPrompt = () => cancelStructuredPrompt(controller, prompt)
  const surface = useNativeChatSurface({
    tabId: props.tabId,
    sessionId: props.sessionId,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerRef,
    questionAnswerInputRef,
    transcriptRef: submits.messageListRef,
    fileLinkContext,
    composerReady: composerShown && install.slot.kind !== 'install',
    surfaceReady: !composerShown || install.slot.kind === 'install',
    conversationShown: viewState.kind === 'ready',
    ...paneCommands,
    onKeyDown: subagents.onKeyDown
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

  const bot = useNativeChatBotHome(session, controller, transport, ownerWorktreeId, hostExecution)

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
    hostNotice: botServerDown ? null : hostNotice,
    kickoffSignIn: bot.signInOwed
  })
  return (
    <NativeChatAntigravityAuthProvider target={install.antigravityAuth}>
      <NativeChatSlackMirrorContext.Provider value={slackMirror}>
        <NativeChatCrewContext.Provider value={crew}>
          <NativeChatSurface
            surface={surface}
            working={controller.isWorking}
            className="[container-type:size]"
          >
            {nativeChatPaneHeader(props, ownerWorktreeId, surface.appearance.colorScheme, handOff)}
            <NativeChatDockTranscript>
              <NativeChatContextClearFade
                // A read failure stays in view: no divider may come to end the fade.
                clearing={controller.contextClear.clearing && viewState.kind !== 'error'}
                overlay={<NativeChatSurfaceFindBar surface={surface} isVisible={props.isVisible} />}
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
                  <NativeChatEmptyPane
                    slot={install.slot}
                    agent={props.agent}
                    tabId={props.tabId}
                  />
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
                        <NativeChatWorkerTimeline
                          approvalParty={workerApprovalParty}
                          workerDock={controller.backgroundTasks.workerDock}
                          target={props.target}
                          sessionId={props.sessionId}
                          isVisible={props.isVisible}
                        >
                          {(timedRows) => (
                            <NativeChatSubagentTranscripts
                              find={surface.find}
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
                              stopping={bot.stopControls.stopping}
                              structuredAttachments
                              runtimeContext={imageRuntimeContext}
                              deliveryNotices={deliveryNotices}
                              {...{ turnBot, botHome: bot.kickoff }}
                              timedRows={timedRows}
                            />
                          )}
                        </NativeChatWorkerTimeline>
                      </NativeChatHostSetupContext.Provider>
                    </NativeChatUsageLimitActionsProvider>
                  </NativeChatRowActionsProvider>
                )}
              </NativeChatContextClearFade>
            </NativeChatDockTranscript>
            <NativeChatDock shown={!readFailure?.final}>
              {composerShown ? null : subagents.dock}
              {subagents.pairedAsks}
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
                  target={props.target}
                  focusComposer={focusComposer}
                />
              )}
              {composerShown || subagentOpen ? null : (
                <NativeChatPromptSlotNotices notices={notices} />
              )}
              {/* A tab on whichever input surface comes next: the prompt card, an async question or the composer. */}
              <NativeChatQueuedMessageList
                controller={submits.queuedMessages}
                chatWorktreeId={ownerWorktreeId ?? null}
                agentName={agentLabel}
                statedFailures={startFailures}
                steerHeld={bot.stopControls.stopping || hostHeld}
                focusComposer={focusComposer}
                editAttachTo={{ terminalTabId: props.tabId, agent: props.agent, transport }}
              />
              <NativeChatStructuredPromptCard
                key={prompt ? `${prompt.itemId}:${prompt.revision}` : undefined}
                prompt={prompt}
                promptResponse={promptResponse}
                onCancel={cancelPrompt}
                shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
                answerInputRef={questionAnswerInputRef}
              />
              {nativeChatStructuredAsyncQuestion(props, controller, session, transport, submits)}
              {botServerDown && hostOutage ? (
                <BotServerOutageCard key={hostOutage.environmentId} outage={hostOutage} />
              ) : null}
              {composerShown && (
                <NativeChatInstallSlot
                  install={install}
                  agentLabel={agentLabel}
                  inCard={viewState.kind === 'ready' && bot.setupFailed}
                />
              )}
              {subagents.statusBar}
              {composerShown ? (
                <NativeChatComposer
                  ref={composerRef}
                  dock={subagents.dock}
                  terminalTabId={props.tabId}
                  paneKey={paneKey}
                  draftScopeKey={structuredAgentSessionDraftScopeKey(props.sessionId)}
                  targetPtyId={null}
                  agent={props.agent}
                  {...bot.stopControls.composer}
                  unavailableHint={install.unavailableHint}
                  steerHead={
                    bot.stopControls.stopping ? undefined : submits.queuedMessages.steerHead
                  }
                  structuredTransport={transport}
                  notices={notices}
                  recallSource={{ messages: session.messages, withoutImageMarkers: true }}
                />
              ) : null}
            </NativeChatDock>
            {handOff.dialog}
          </NativeChatSurface>
        </NativeChatCrewContext.Provider>
      </NativeChatSlackMirrorContext.Provider>
    </NativeChatAntigravityAuthProvider>
  )
}
