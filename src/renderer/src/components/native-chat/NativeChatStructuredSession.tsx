import { useMemo, useRef, useState } from 'react'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { selectNativeChatViewState } from './native-chat-view-state'
import { useNativeChatComposerRevealFocus } from './use-native-chat-composer-reveal-focus'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
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
import { NativeChatDeliveryRetry } from './NativeChatDeliveryRetry'
import { isNativeChatCompacting, selectNativeChatGoal } from './native-chat-runtime-status'
import { NativeChatRuntimeStatus } from './NativeChatRuntimeStatus'

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function NativeChatStructuredSession(
  props: Omit<NativeChatStructuredViewProps, 'mode'>
): React.JSX.Element {
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const provisionalLaunch = useNativeChatProvisionalLaunch(
    fileLinkContext?.worktreeId,
    props.sessionId
  )
  const controller = useStructuredAgentSession({
    ...props,
    transportEnabled: provisionalLaunch.transportEnabled
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
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(props.tabId, props.sessionId),
    [props.sessionId, props.tabId]
  )
  const rootRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  const paneCommands = useStructuredNativeChatPaneCommands({
    tabId: props.tabId,
    groupId: props.groupId,
    isVisible: props.isVisible,
    rootRef,
    composerRef,
    terminalPaneActions: props.contextMenuActions
  })
  const session = useMemo<NativeChatLiveSession>(
    () => ({
      messages: controller.messages,
      status:
        controller.status === 'error'
          ? 'error'
          : controller.status === 'loading'
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
      loadEarlier: () => void controller.loadOlder(),
      readPhase:
        controller.status === 'loading'
          ? 'loading'
          : controller.status === 'error'
            ? 'error'
            : 'ready'
    }),
    [controller, props.agent, props.sessionId]
  )
  const viewState = selectNativeChatViewState(session)
  const fontScale = useNativeChatFontScale(viewState.kind === 'ready')
  const imageRuntimeContext = useNativeChatImageRuntimeContext(props.tabId)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId: props.sessionId, isVisible: props.isVisible }
  )
  const prompt = controller.prompts[0] ?? null
  const goal = useMemo(
    () => selectNativeChatGoal(controller.journalItems),
    [controller.journalItems]
  )
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
    composerReady: prompt === null
  })
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const questions =
    questionBody?.questions ??
    (questionBody
      ? [
          {
            id: questionBody.freeTextQuestionId ?? 'q1',
            question: questionBody.question,
            options: questionBody.options,
            multiSelect: false,
            ...(questionBody.freeTextQuestionId
              ? { freeTextQuestionId: questionBody.freeTextQuestionId }
              : {})
          }
        ]
      : [])
  const structuredTransport = useMemo(
    () => ({
      send: (text: string, attachments: readonly { id: string; path: string }[]): boolean =>
        controller.send(
          text,
          attachments.map((attachment) => ({
            path: attachment.path,
            previewUri: attachment.path
          }))
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
          runConversationCommand: controller.runConversationCommand
        }),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      worktreeId: fileLinkContext?.worktreeId,
      onError: setComposerError,
      runtime: (props.target.kind === 'local' ? 'local' : 'remote') as 'local' | 'remote',
      sessionId: props.sessionId,
      runtimeEnvironmentId:
        props.target.kind === 'local' ? null : (props.target.environmentId ?? null)
    }),
    [
      controller,
      fileLinkContext?.worktreeId,
      optionPickerRequest,
      props.agent,
      props.sessionId,
      props.target
    ]
  )

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
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {viewState.kind === 'loading' ? (
          <NativeChatEmptyState kind="loading" />
        ) : viewState.kind === 'error' ? (
          <NativeChatEmptyState kind="error" message={viewState.message} />
        ) : viewState.kind === 'empty' ? (
          <NativeChatEmptyState kind="empty" agent={props.agent} />
        ) : (
          <NativeChatMessageList
            session={session}
            journalItems={controller.journalItems}
            isVisible={props.isVisible}
            isWorking={controller.isWorking}
            expandSignal={false}
            fontScale={fontScale.scale}
            workingStartedAt={controller.workingStartedAt}
            settledTurns={controller.settledTurns}
            showTurnStatus
            showLiveTurnActivity={prompt === null}
            turnActivity={controller.turnActivity}
            onLinkClick={onLinkClick}
            allowFileUriLinks={onLinkClick !== undefined}
            runtimeContext={imageRuntimeContext}
          />
        )}
      </div>
      <NativeChatRuntimeStatus
        goal={goal}
        compacting={isNativeChatCompacting(controller.turnActivity)}
      />
      {prompt && approval ? (
        <NativeChatApprovalCard
          key={`${prompt.itemId}:${prompt.revision}`}
          approval={approval}
          onChoose={(optionId) => void controller.respond(prompt, optionId)}
          onCancel={cancelPrompt}
          shouldFocus={props.isVisible && props.isFocusedGroup}
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
            if (questionBody.questions) {
              const grouped = questions.map((question, questionIndex) => {
                const answer = answers[questionIndex]
                const other = answer?.other?.trim()
                const optionIds = (answer?.indices ?? []).flatMap((optionIndex) => {
                  const optionId = question.options[optionIndex]?.id
                  return optionId ? [optionId] : []
                })
                return {
                  questionId: question.id,
                  optionIds: question.multiSelect || !other ? optionIds : [],
                  ...(other ? { other } : {})
                }
              })
              if (grouped.every((answer) => answer.optionIds.length > 0 || answer.other)) {
                void controller.respond(prompt, encodeAgentSessionQuestionAnswers(grouped))
              }
              return
            }
            const index = answers[0]?.indices[0]
            const other = answers[0]?.other?.trim()
            const optionId =
              typeof index === 'number'
                ? questionBody.options[index]?.id
                : questionBody.freeTextQuestionId && other
                  ? encodeQuestionAnswer(questionBody.freeTextQuestionId, other)
                  : undefined
            if (optionId) {
              void controller.respond(prompt, optionId)
            }
          }}
          onCancel={cancelPrompt}
        />
      ) : null}
      <NativeChatDeliveryRetry
        outbox={controller.outbox}
        blockedClientMessageId={controller.blockedClientMessageId}
        retry={controller.retry}
      />
      <NativeChatLaunchRetry
        lifecycle={provisionalLaunch.lifecycle}
        onRetry={provisionalLaunch.retry}
      />
      <NativeChatStructuredSessionStatus
        sessionId={props.sessionId}
        error={controller.error}
        composerError={composerError}
        isVisible={props.isVisible}
        backgroundTasks={controller.backgroundTasks}
        stopBackgroundTask={controller.stopBackgroundTask}
      />
      {prompt ? null : (
        <NativeChatComposer
          ref={composerRef}
          terminalTabId={props.tabId}
          paneKey={paneKey}
          targetPtyId={null}
          agent={props.agent}
          canSend={!prompt}
          // Stop, not status: only a provider-minted turn can be interrupted, so the button
          // must not flip while a dispatch is still unanswered.
          isWorking={controller.turnId !== null}
          onStop={() => {
            if (controller.turnId) {
              void controller.cancel(controller.turnId)
            }
          }}
          structuredTransport={structuredTransport}
          launchSeed={{ ...launchDraftSignal, ownsTabWideLaunchDraft: true }}
        />
      )}
      {paneCommands.menu}
      <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
    </div>
  )
}
