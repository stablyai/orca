import { NativeChatStructuredPrompts } from './prompts/NativeChatStructuredAsyncQuestion'
import { NativeChatPaneFileDropScope } from './attachments/intake/NativeChatPaneFileDropSurface'
import { useNativeChatHandOff } from './pane/actions/use-native-chat-hand-off'
import { useNativeChatStructuredPaneNotices } from '@/components/native-chat/messages/notices/use-native-chat-structured-pane-notices'
import { useNativeChatPaneFork } from '@/components/native-chat/messages/actions/use-native-chat-fork'
import { cn } from '@/lib/utils'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from '@/components/native-chat/appearance/native-chat-appearance-style'
import { useNativeChatStoreAppearanceStyle } from '@/components/native-chat/appearance/use-native-chat-store-appearance-style'
import { useRef, useState } from 'react'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useStructuredChatLiveSession } from './session/structured/use-structured-chat-live-session'
import { NativeChatComposer } from './composer/NativeChatComposer'
import type { NativeChatComposerHandle } from './composer/native-chat-composer-types'
import type { NativeChatOptionPickerRequest } from './session/options/controls/native-chat-option-picker-request'
import { structuredAgentSessionDraftScopeKey } from './drafts/native-chat-draft-scope'
import { NativeChatEmptyState } from './host-access/NativeChatEmptyState'
import { NativeChatEmptyPane } from './host-access/NativeChatEmptyPane'
import { NativeChatLoadingCue } from './host-access/NativeChatLoadingCue'
import {
  NativeChatStructuredTranscript,
  NativeChatStructuredTranscriptFrame
} from './NativeChatStructuredTranscript'
import { NativeChatChildTranscriptStack } from './NativeChatChildTranscript'
import type { NativeChatMessageListHandle } from './messages/actions/use-native-chat-reveal-latest'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigator
} from './native-chat-child-navigation'
import { NativeChatContextClearFade } from './conversation/projection/NativeChatContextClearFade'
import { useStructuredNativeChatSubmitReveal } from './pane/actions/use-structured-native-chat-submit-reveal'
import { useStructuredPromptResponseHold } from './prompts/use-structured-prompt-response-hold'
import {
  selectNativeChatViewState,
  structuredChatHistoryPhase
} from './session/status/native-chat-view-state'
import { useNativeChatRootInputRouting } from './composer/focus/use-native-chat-root-input-routing'
import { useNativeChatFontSize } from './appearance/use-native-chat-font-size'
import { useNativeChatFind } from './viewport/find/use-native-chat-find'
import { NativeChatFindBar } from './viewport/find/NativeChatFindBar'
import { nativeChatQueueFollowUps } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './links/actions/use-native-chat-link-actions'
import { NativeChatLinkClickContext } from './links/actions/native-chat-link-click-context'
import { useNativeChatFileLinkContext } from './links/actions/use-native-chat-file-link-context'
import { useRecheckNativeChatFileLinksWhenTurnEnds } from './links/actions/use-native-chat-file-link-existence'
import { useNativeChatTabOwnerWorktreeId } from './pane/ownership/use-native-chat-tab-owner'
import { useStructuredAgentSession } from './session/structured/use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from './media/images/native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './pane/actions/use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatStructuredSessionStatus } from './tools/tasks/NativeChatStructuredSessionStatus'
import { useNativeChatInterruptedContinuation } from './usage/NativeChatInterruptedContinue'
import { NativeChatPromptSlotNotices } from './composer/controls/NativeChatComposerNotices'
import {
  NativeChatInstallSlot,
  useNativeChatInstallSlot
} from './host-access/NativeChatInstallSlot'
import { useNativeChatComposerError } from './composer/controls/use-native-chat-composer-notice'
import { useNativeChatProvisionalLaunch } from './host-access/use-native-chat-provisional-launch'
import { useStructuredAgentSessionHostExecution } from './session/status/structured-agent-session-status-hooks'
import { useNativeChatRewindHost } from './messages/actions/use-native-chat-rewind-host'
import { NativeChatQueuedMessageList } from './queue/NativeChatQueuedMessageList'
import { nativeChatStructuredStopControls } from './session/structured/writes/native-chat-structured-stop-controls'
import { useAppStore } from '../../store'
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

export function NativeChatStructuredSession(props: Omit<NativeChatStructuredViewProps, 'mode'>) {
  const ownerWorktreeId = useNativeChatTabOwnerWorktreeId(props.tabId)
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(ownerWorktreeId, props.sessionId)
  // The host's own word on whether the provider child has answered startup yet.
  const hostExecution = useStructuredAgentSessionHostExecution(props.sessionId, props.target)
  const paneKey = structuredAgentSessionPaneKey(props.tabId, props.sessionId)
  const childNavigator = useNativeChatChildNavigator(JSON.stringify([paneKey, props.target]))
  const childMessageListRef = useRef<NativeChatMessageListHandle>(null)
  const readOnlyComposerRef = useRef<NativeChatComposerHandle>(null)
  // Chat-wide preference; an alternate send flips it for one message.
  const queueFollowUps = useAppStore((store) => nativeChatQueueFollowUps(store.settings))
  const composerRef = useRef<NativeChatComposerHandle>(null)
  // Paste target while a question card replaces the composer.
  const questionAnswerInputRef = useRef<HTMLTextAreaElement>(null)
  const childAnswerInputRef = useRef<HTMLTextAreaElement>(null)
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
  const activeComposerRef = childNavigator.child ? readOnlyComposerRef : composerRef
  const activeAnswerInputRef = childNavigator.child ? childAnswerInputRef : questionAnswerInputRef
  const activeMessageListRef = childNavigator.child ? childMessageListRef : submits.messageListRef
  const find = useNativeChatFind(paneActive, rootRef, activeComposerRef, activeMessageListRef)
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
    composerRef: activeComposerRef,
    questionAnswerInputRef: activeAnswerInputRef,
    messageListRef: activeMessageListRef,
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
  const canMention = composerShown && install.unavailableHint === undefined
  const rootInput = useNativeChatRootInputRouting({
    tabId: props.tabId,
    rootRef,
    composerRef: activeComposerRef,
    questionAnswerInputRef: activeAnswerInputRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady:
      composerShown && install.slot.kind !== 'install' && childNavigator.child === null,
    surfaceReady: !composerShown || install.slot.kind === 'install' || childNavigator.child !== null
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

  const { signIn, notices } = useNativeChatStructuredPaneNotices({
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
    <NativeChatChildNavigationContext.Provider value={childNavigator.navigation}>
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
        <NativeChatPaneFileDropScope
          enabled={childNavigator.child === null}
          hidden={childNavigator.child !== null}
          inert={childNavigator.child !== null}
          className={childNavigator.child ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        >
          <NativeChatStructuredTranscriptFrame
            pane={props}
            composerRef={composerRef}
            canMention={canMention && childNavigator.child === null}
            isVisible={props.isVisible && childNavigator.child === null}
          >
            <NativeChatContextClearFade
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
                <NativeChatStructuredTranscript
                  pane={props}
                  directory={fileLinkContext}
                  controller={controller}
                  continuation={continuation.view}
                  signIn={signIn}
                  forks={forks}
                  messageListRef={submits.messageListRef}
                  session={session}
                  isVisible={props.isVisible && childNavigator.child === null}
                  awaitingInput={prompt === null ? null : 'shown'}
                  stopping={stopControls.stopping}
                  runtimeContext={imageRuntimeContext}
                  deliveryNotices={deliveryNotices}
                />
              )}
            </NativeChatContextClearFade>
          </NativeChatStructuredTranscriptFrame>
          {readFailure?.final ? null : (
            <>
              {/* Host-held drafts, never transcript rows. Above the status area, so running shells and agents sit next to the composer. */}
              <NativeChatQueuedMessageList
                controller={submits.queuedMessages}
                chatWorktreeId={ownerWorktreeId ?? null}
                agentName={agentLabel}
                statedFailures={startFailures}
                steerHeld={stopControls.stopping || hostHeld}
                focusComposer={focusComposer}
                editAttachTo={{ terminalTabId: props.tabId, agent: props.agent, transport }}
              />
              <NativeChatStructuredSessionStatus
                sessionId={props.sessionId}
                paneKey={paneKey}
                isVisible={props.isVisible}
                tasks={controller}
                messageListRef={submits.messageListRef}
              />
              {prompt ? null : (
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
              {/* Prompt cards take the composer's slot, below the background-task dock. */}
              {composerShown ? null : <NativeChatPromptSlotNotices notices={notices} />}
              <NativeChatStructuredPrompts
                pane={props}
                controller={controller}
                response={promptResponse}
                session={session}
                transport={transport}
                submits={submits}
                shouldFocus={!promptsUnanswerable && paneActive && childNavigator.child === null}
                answerInputRef={questionAnswerInputRef}
              />

              {composerShown && (
                <NativeChatInstallSlot slot={install.slot} agentLabel={agentLabel} />
              )}
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
        </NativeChatPaneFileDropScope>
        {childNavigator.child ? (
          <NativeChatChildTranscriptStack
            messageListRef={childMessageListRef}
            path={childNavigator.path}
            onBack={childNavigator.back}
            session={session}
            roster={controller.subagentRoster}
            isVisible={props.isVisible}
            onLinkClick={onLinkClick}
            runtimeContext={imageRuntimeContext}
          />
        ) : null}
        {paneCommands.menu}
        {handOff.dialog}
        <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
      </div>
    </NativeChatChildNavigationContext.Provider>
  )
  return <NativeChatLinkClickContext value={onLinkClick}>{root}</NativeChatLinkClickContext>
}
