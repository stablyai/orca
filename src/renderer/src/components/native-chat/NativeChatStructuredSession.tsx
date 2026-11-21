import { useBotLinkPrompt } from '@/lib/agent-session/open/bot-link-item-target'
import {
  NativeChatCrewContext,
  useNativeChatCrewSource
} from '../orchestration-crew/use-native-chat-crew'
import { NativeChatUsageLimitActionsProvider } from './usage/NativeChatUsageLimitActions'
import { useNativeChatHandOff } from './pane/actions/use-native-chat-hand-off'
import { useNativeChatPaneAuxiliaryActions } from './pane/actions/use-native-chat-pane-auxiliary-actions'
import { useNativeChatStructuredPaneNotices } from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import { useRef, useState } from 'react'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useNativeChatStructuredHistory } from './session/structured/use-native-chat-structured-history'
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
import { nativeChatStructuredAsyncQuestion } from './prompts/NativeChatStructuredAsyncQuestion'
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
import { useNativeChatStructuredEscapeStop } from './session/structured/writes/use-native-chat-structured-escape-stop'
import { useAppStore } from '@/store/index'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'
import { useNativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/use-native-chat-structured-composer-transport'
import { NativeChatStructuredComposerTabStrips } from '@/components/native-chat/pane/actions/NativeChatStructuredComposerTabStrips'
import { nativeChatPaneHeader } from '@/components/native-chat/pane/actions/NativeChatPaneHeader'
import { useStructuredAgentSessionDeliveryNotices } from '@/components/native-chat/session/structured/delivery/use-structured-agent-session-delivery-notices'
import { dispatchWasWithdrawn } from '../../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { useNativeChatHostOutage } from '@/components/native-chat/host-access/use-native-chat-host-outage'
import { useBotForWorkspace } from '@/components/bots/bot-workspace'
import { BotServerOutageCard } from '@/components/bots/BotServerOutageCard'
import { useStructuredAgentSessionStartFailureFacts } from '@/components/native-chat/messages/notices/use-structured-agent-session-start-failure-facts'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session/requests/prompts/agent-session-approval-subject'
import { NativeChatHostSetupContext } from '@/components/native-chat/host-access/native-chat-host-setup'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import {
  NativeChatPartyWorkerApprovalStack,
  NativeChatWorkerApprovalTimeline,
  nativeChatWorkerApprovalParty
} from './worker-approvals/NativeChatWorkerApprovals'

export function NativeChatStructuredSession(props: Omit<NativeChatStructuredViewProps, 'mode'>) {
  const { agent, tabId } = props
  const { ownerWorktreeId: tabOwnerWorktreeId, turnBot, bot: chatBot } = useBotChatOwner(props)
  const ownerWorktreeId = props.auxiliaryOwnerWorktreeId ?? tabOwnerWorktreeId
  const isAuxiliary = props.auxiliaryOwnerWorktreeId !== undefined
  const fileTabId = props.auxiliaryParentTabId ?? tabId
  const slackMirror = useNativeChatSlackMirror(chatBot, props.sessionId)
  const fileLinkContext = useNativeChatFileLinkContext(fileTabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(ownerWorktreeId, props.sessionId)
  const hostExecution = useStructuredAgentSessionHostExecution(props.sessionId, props.target)
  const paneKey = structuredAgentSessionPaneKey(tabId, props.sessionId)
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
  // A bot page reads the raw outage too; a plain chat reads it through its history hook.
  const hostOutage = useNativeChatHostOutage(props.target)
  const { historyPhase, hostNotice, session, hostSendGate, readFailure, viewState } =
    useNativeChatStructuredHistory(props, controller, provisionalLaunch)
  const agentLabel = structuredAgentLabel(props.agent)
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
  const paneActive = props.isVisible && props.isFocusedGroup
  const imageRuntimeContext = useNativeChatImageRuntimeContext(fileTabId)
  const handOff = useNativeChatHandOff({
    pane: props,
    directory: isAuxiliary ? null : fileLinkContext,
    messages: controller.messages,
    epoch: controller.epoch,
    focusComposer
  })
  const forks = useNativeChatPaneFork(props, controller, isAuxiliary ? null : ownerWorktreeId)
  const prompt = useBotLinkPrompt(props.sessionId, controller.prompts)
  // Unknown prompts leave the composer usable; a send starts a turn whose cancel can resolve them.
  const promptsUnanswerable = pendingPromptsAllUnanswerableHere(controller.prompts)
  // A bot's page whose server is down keeps its last read; the recovery card stands in for the composer.
  // An auxiliary chat is its own conversation, not the bot page that owns its workspace.
  const pageBot = useBotForWorkspace(isAuxiliary ? null : ownerWorktreeId)
  const botServerDown = pageBot !== null && hostOutage !== null && hostOutage.kind !== 'stopped'
  const subagents = useStructuredNativeChatSubagents({ ...props, paneKey, controller })
  const subagentOpen = subagents.openId !== null
  // A subagent's view takes the composer's place; the main agent's prompts still show.
  const composerShown =
    (prompt === null || promptsUnanswerable) &&
    readFailure?.final !== true &&
    !botServerDown &&
    !subagentOpen
  const auxiliaryOwner = !isAuxiliary && paneActive ? ownerWorktreeId : null
  const canAttachSelection = composerShown && prompt === null
  const auxiliary = useNativeChatPaneAuxiliaryActions(props, auxiliaryOwner, canAttachSelection)
  const rewind = isAuxiliary ? undefined : controller.rewind.surface
  const paneCommands = useStructuredNativeChatPaneCommands({
    pane: props,
    handOff,
    sessionContext: controller,
    ownerWorktreeId: isAuxiliary ? null : ownerWorktreeId,
    composerRef,
    rewind,
    auxiliaryChat: auxiliary.selection
  })
  // An owned prompt keeps its card; otherwise a missing program leaves the composer disabled.
  const installLayout = viewState.kind === 'empty' ? 'hero' : 'strip'
  const install = useNativeChatInstallSlot(props, agentLabel, installLayout)
  const crew = useNativeChatCrewSource({
    target: props.target,
    sessionId: props.sessionId,
    isVisible: props.isVisible,
    composerRef,
    canMention: composerShown && install.unavailableHint === undefined
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
  const transport = useNativeChatStructuredComposerTransport({
    props,
    controller,
    forks,
    auxiliarySideChat: auxiliary.commands,
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

  const bot = useNativeChatBotHome(
    session,
    controller,
    transport,
    isAuxiliary ? null : ownerWorktreeId,
    hostExecution
  )
  useNativeChatStructuredEscapeStop({
    rootRef: surface.rootRef,
    visible: props.isVisible,
    defaultOwner: !isAuxiliary && props.isFocusedGroup,
    // A new bot's kickoff keeps its first words safe from a stray Escape, as its composer does.
    onStop: bot.stopControls.composer.escapeStops ? bot.stopControls.composer.onStop : undefined
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
    hostNotice: botServerDown ? null : hostNotice,
    kickoffSignIn: bot.signInOwed
  })
  return (
    <NativeChatAntigravityAuthProvider target={install.antigravityAuth}>
      <NativeChatSlackMirrorContext.Provider value={slackMirror}>
        <NativeChatCrewContext.Provider value={crew}>
          <NativeChatSurface surface={surface} working={controller.isWorking}>
            {nativeChatPaneHeader(props, ownerWorktreeId, surface.appearance.colorScheme, handOff)}
            <div className="relative flex min-h-0 flex-1 flex-col">
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
                  <NativeChatEmptyPane slot={install.slot} agent={agent} tabId={tabId} />
                ) : (
                  <NativeChatRowActionsProvider pane={props} rewind={rewind} forks={forks}>
                    <NativeChatUsageLimitActionsProvider
                      recovery={controller}
                      pane={props}
                      directory={fileLinkContext}
                      messages={controller.messages}
                      view={continuation.view}
                    >
                      <NativeChatHostSetupContext.Provider value={setup}>
                        <NativeChatWorkerApprovalTimeline
                          party={workerApprovalParty}
                          target={props.target}
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
                        </NativeChatWorkerApprovalTimeline>
                      </NativeChatHostSetupContext.Provider>
                    </NativeChatUsageLimitActionsProvider>
                  </NativeChatRowActionsProvider>
                )}
              </NativeChatContextClearFade>
            </div>
            {readFailure?.final ? null : (
              <>
                {/* Keep queued drafts outside the transcript and above the background-task dock. */}
                <NativeChatQueuedMessageList
                  controller={submits.queuedMessages}
                  chatWorktreeId={ownerWorktreeId ?? null}
                  agentName={agentLabel}
                  statedFailures={startFailures}
                  steerHeld={bot.stopControls.stopping || hostHeld}
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
                    threadGoal={isAuxiliary ? undefined : controller.threadGoal}
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
              </>
            )}
            {handOff.dialog}
          </NativeChatSurface>
        </NativeChatCrewContext.Provider>
      </NativeChatSlackMirrorContext.Provider>
    </NativeChatAntigravityAuthProvider>
  )
}
