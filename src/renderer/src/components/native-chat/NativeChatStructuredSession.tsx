import { cn } from '@/lib/utils'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  useNativeChatAppearanceStyle
} from './native-chat-appearance-style'
import { useMemo, useRef, useState } from 'react'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatLoadingCue } from './NativeChatLoadingCue'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { selectNativeChatViewState, structuredChatHistoryPhase } from './native-chat-view-state'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { useNativeChatFontSize } from './use-native-chat-font-size'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import { NativeChatLaunchRetry } from './NativeChatLaunchRetry'
import { useNativeChatProvisionalLaunch } from './use-native-chat-provisional-launch'
import { useStructuredAgentSessionHostExecutionPhase } from './StructuredAgentSessionStatusBridge'
import { useNativeChatRewindHost } from './use-native-chat-rewind-host'
import { NativeChatRewindContext } from './native-chat-rewind-context'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { useAppStore } from '../../store'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { structuredAgentSessionReadFailureNotice } from './structured-agent-session-read-failure-notice'
import { useStructuredAgentSessionDeliveryNotices } from './use-structured-agent-session-delivery-notices'
import { pendingPromptsAllUnanswerableHere } from '../../../../shared/agent-session-approval-subject'

export function NativeChatStructuredSession(
  props: Omit<NativeChatStructuredViewProps, 'mode'>
): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(
    fileLinkContext?.worktreeId,
    props.sessionId
  )
  const { sendThroughRelaunch } = provisionalLaunch
  // The host's own word on whether the provider child has answered startup yet.
  const startupPhase = useStructuredAgentSessionHostExecutionPhase(props.sessionId, props.target)
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(props.tabId, props.sessionId),
    [props.sessionId, props.tabId]
  )
  // Chat-wide: absent means on; only an explicit off keeps mid-turn sends immediate.
  const queueFollowUps = useAppStore((store) => store.settings?.nativeChatQueueFollowUps !== false)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const { rewindHost, focusComposer } = useNativeChatRewindHost(props, composerRef)
  const controller = useStructuredAgentSession({
    ...props,
    // Why: Stop and a queued card's Edit give text back to the conversation's draft, as the composer keeps it.
    composerScopeKey: structuredAgentSessionDraftScopeKey(props.sessionId),
    queueFollowUps,
    providerStarting: startupPhase === 'starting',
    rewind: rewindHost,
    transportEnabled: provisionalLaunch.transportEnabled,
    ...(provisionalLaunch.launch ? { launch: provisionalLaunch.launch } : {})
  })
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId: props.tabId,
    agent: props.agent,
    messages: controller.messages,
    // Why: the controller starts at `idle`, before any read; like the legacy view's unsettled
    // phases, that empty list must not become the draft's turn baseline.
    transcriptLoading: controller.status === 'idle' || controller.status === 'loading'
  })
  const [composerError, setComposerError] = useState<string | null>(null)
  const [optionPickerRequest, setOptionPickerRequest] = useState<{
    id: string
    sequence: number
  } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const paneCommands = useStructuredNativeChatPaneCommands({
    tabId: props.tabId,
    groupId: props.groupId,
    isVisible: props.isVisible,
    rootRef,
    composerRef,
    terminalPaneActions: props.contextMenuActions,
    sessionId: props.sessionId,
    target: props.target
  })
  const historyPhase = structuredChatHistoryPhase(provisionalLaunch, controller.status)
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      messages: controller.messages,
      status:
        controller.status === 'error'
          ? 'error'
          : historyPhase !== 'known'
            ? 'loading'
            : controller.isWorking
              ? 'working'
              : controller.messages.length === 0
                ? 'empty'
                : 'ready',
      sessionId: props.sessionId,
      agent: props.agent,
      ...(controller.error ? { error: controller.error } : {}),
      hasMore: controller.hasOlder,
      loadingEarlier: controller.loadingOlder,
      olderHistoryGeneration: controller.olderHistoryGeneration,
      loadEarlier: controller.loadOlder,
      readPhase:
        controller.status === 'loading'
          ? 'loading'
          : controller.status === 'error'
            ? 'error'
            : 'ready'
    }),
    [controller, historyPhase, props.agent, props.sessionId]
  )
  const agentLabel = structuredAgentLabel(props.agent)
  const deliveryNotices = useStructuredAgentSessionDeliveryNotices({
    outbox: controller.outbox,
    submissions: controller.submissions,
    journalItems: controller.journalItems,
    failedHere: controller.failedHere,
    retry: controller.retry,
    agentName: agentLabel
  })
  // Nothing reads an unread history, so its pane stays blank beside the Retry line.
  const loadingPane = historyPhase === 'unread' ? null : <NativeChatLoadingCue />
  const readFailure =
    controller.status === 'error'
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
  const appearanceSettings = useAppStore((state) => state.settings?.nativeChatAppearance)
  const appearanceStyle = useNativeChatAppearanceStyle({ nativeChatAppearance: appearanceSettings })
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
  const approvalBody = prompt?.body.kind === 'approval' ? prompt.body : null
  const approval = approvalBody
    ? {
        title: approvalBody.title,
        ...(approvalBody.displayName ? { displayName: approvalBody.displayName } : {}),
        ...(approvalBody.description ? { description: approvalBody.description } : {}),
        ...(approvalBody.decisionReason ? { decisionReason: approvalBody.decisionReason } : {}),
        ...(approvalBody.blockedPath ? { blockedPath: approvalBody.blockedPath } : {}),
        ...(approvalBody.matchedAskRule ? { matchedAskRule: approvalBody.matchedAskRule } : {}),
        ...(approvalBody.subject ? { subject: approvalBody.subject } : {}),
        ...(approvalBody.detail ? { detail: approvalBody.detail } : {}),
        options: approvalBody.options.map((option) => ({
          label: option.label,
          send: option.id
        }))
      }
    : null
  const cancelPrompt = () => {
    if (controller.turnId && prompt) {
      void controller.cancel(controller.turnId, {
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
  const structuredTransport = useMemo(() => {
    const threadGoal = controller.threadGoal
    const setThreadGoalObjective = threadGoal
      ? (objective: string) => threadGoal.change({ kind: 'set', objective })
      : null
    return {
      send: (text: string, attachments: readonly { id: string; path: string }[]): boolean =>
        sendThroughRelaunch(() =>
          controller.send(
            text,
            attachments.map((attachment) => ({
              path: attachment.path,
              previewUri: attachment.path
            }))
          )
        ),
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: props.agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async (id) => {
            setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
            return true
          },
          setOption: controller.setStructuredOption,
          conversationCommands: controller.conversationCommands,
          runConversationCommand: controller.runConversationCommand,
          ...(setThreadGoalObjective ? { setThreadGoalObjective } : {})
        }),
      ...(setThreadGoalObjective ? { threadGoal: { setObjective: setThreadGoalObjective } } : {}),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      contextUsage: controller.contextUsage,
      worktreeId: fileLinkContext?.worktreeId,
      onError: setComposerError,
      runtime: (props.target.kind === 'local' ? 'local' : 'remote') as 'local' | 'remote',
      sessionId: props.sessionId,
      runtimeEnvironmentId:
        props.target.kind === 'local' ? null : (props.target.environmentId ?? null)
    }
  }, [
    controller,
    fileLinkContext?.worktreeId,
    optionPickerRequest,
    props.agent,
    props.sessionId,
    props.target,
    sendThroughRelaunch
  ])

  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      data-native-chat-working={controller.isWorking ? 'true' : 'false'}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button === 2) {
          paneCommands.onSelectionCapture()
        }
      }}
      onMouseUpCapture={paneCommands.onSelectionCapture}
      onKeyUpCapture={paneCommands.onSelectionCapture}
      onKeyDownCapture={paneCommands.onKeyDownCapture}
      onContextMenuCapture={paneCommands.onContextMenuCapture}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none'
      )}
      style={appearanceStyle}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
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
            <NativeChatMessageList
              // A rewind replaces the conversation; nothing the old transcript held carries over.
              key={controller.epoch ?? undefined}
              session={session}
              journalItems={controller.journalItems}
              journalSubmissions={controller.submissions}
              subagentRoster={controller.subagentRoster}
              railOutline={controller.railOutline}
              isVisible={props.isVisible}
              isWorking={controller.isWorking}
              expandSignal={false}
              workingStartedAt={controller.workingStartedAt}
              settledTurns={controller.settledTurns}
              awaitingInput={prompt === null ? null : 'shown'}
              turnActivity={controller.turnActivity}
              onLinkClick={onLinkClick}
              allowFileUriLinks={onLinkClick !== undefined}
              runtimeContext={imageRuntimeContext}
              deliveryNotices={deliveryNotices}
            />
          </NativeChatRewindContext.Provider>
        )}
      </div>
      {readFailedFinally ? null : (
        <>
          <NativeChatLaunchRetry
            lifecycle={provisionalLaunch.lifecycle}
            failure={provisionalLaunch.failure}
            agentLabel={agentLabel}
            onRetry={provisionalLaunch.retry}
          />
          {/* Host-held drafts, never transcript rows. Above the status area, so running shells and agents sit next to the composer. */}
          <NativeChatQueuedMessageList
            controller={controller.queuedMessages}
            focusComposer={focusComposer}
          />
          <NativeChatStructuredSessionStatus
            sessionId={props.sessionId}
            paneKey={paneKey}
            // Said once: on the pane when the failure took it, else here beside the transcript. A
            // failure that names nothing is only the pane reconnecting.
            error={
              viewState.kind === 'error' || !readFailure?.named
                ? controller.error
                : readFailure.text
            }
            reconnecting={viewState.kind !== 'error' && readFailure !== null && !readFailure.named}
            composerError={composerError}
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
          {prompt && approval ? (
            <NativeChatApprovalCard
              key={`${prompt.itemId}:${prompt.revision}`}
              approval={approval}
              onChoose={(optionId) => void controller.respond(prompt, { kind: 'option', optionId })}
              onCancel={cancelPrompt}
              shouldFocus={!promptsUnanswerable && props.isVisible && props.isFocusedGroup}
              onLinkClick={onLinkClick}
              allowFileUriLinks={onLinkClick !== undefined}
            />
          ) : null}
          {prompt && questionBody ? (
            <NativeChatQuestionCard
              key={`${prompt.itemId}:${prompt.revision}`}
              prompt={{
                questions: questions.map((question) => ({
                  question: question.question,
                  ...(question.header ? { header: question.header } : {}),
                  multiSelect: question.multiSelect,
                  options: question.options.map((option) => ({
                    label: option.label,
                    ...(option.description ? { description: option.description } : {})
                  }))
                }))
              }}
              allowOther={questions.map((question) => Boolean(question.freeTextQuestionId))}
              onAnswer={(answers) => {
                const chosen = questions.map((question, questionIndex) => {
                  const answer = answers[questionIndex]
                  const other = answer?.other?.trim()
                  const optionIds = (answer?.indices ?? []).flatMap((optionIndex) => {
                    const optionId = question.options[optionIndex]?.id
                    return optionId ? [optionId] : []
                  })
                  return { questionId: question.id, optionIds, ...(other ? { other } : {}) }
                })
                if (chosen.every((answer) => answer.optionIds.length > 0 || answer.other)) {
                  void controller.respond(prompt, { kind: 'answers', answers: chosen })
                }
              }}
              onCancel={cancelPrompt}
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
              isWorking={controller.canStop}
              onStop={() => void controller.stop()}
              steerQueued={controller.queuedMessages.steerNewest}
              structuredTransport={structuredTransport}
              launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft: true }}
            />
          ) : null}
        </>
      )}
      {paneCommands.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
