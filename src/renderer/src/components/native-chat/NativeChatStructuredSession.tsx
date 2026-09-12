import { useMemo, useRef, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { Button } from '@/components/ui/button'
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
import { translate } from '@/i18n/i18n'
import { useNativeChatImageRuntimeContext } from './native-chat-image-runtime-context'
import { useStructuredNativeChatPaneCommands } from './use-structured-native-chat-pane-commands'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import { NativeChatBackgroundTasksStatus } from './NativeChatBackgroundTasksStatus'
import { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'

type StoppingBackgroundTasks = {
  sessionId: string
  taskIds: ReadonlySet<string>
  all: boolean
}

const NO_STOPPING_TASKS: ReadonlySet<string> = new Set()

type ExpandedBackgroundTasks = { sessionId: string; expanded: boolean }

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function NativeChatStructuredSession(
  props: Omit<NativeChatStructuredViewProps, 'mode'>
): React.JSX.Element {
  const controller = useStructuredAgentSession(props)
  const launchDraftSignal = useNativeChatLaunchDraftSignal({
    terminalTabId: props.tabId,
    agent: props.agent,
    messages: controller.messages,
    // Why: the controller starts at `idle`, before any read; like the legacy view's unsettled
    // phases, that empty list must not become the draft's turn baseline.
    transcriptLoading: controller.status === 'idle' || controller.status === 'loading'
  })
  const [composerError, setComposerError] = useState<string | null>(null)
  const [stoppingBackgroundTasks, setStoppingBackgroundTasks] =
    useState<StoppingBackgroundTasks | null>(null)
  // Held here, not in the strip: the strip unmounts whenever live work briefly
  // drops to nothing, and its own state would collapse the list each time.
  const [expandedBackgroundTasks, setExpandedBackgroundTasks] =
    useState<ExpandedBackgroundTasks | null>(null)
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
  const fileLinkContext = useNativeChatFileLinkContext(props.tabId)
  const imageRuntimeContext = useNativeChatImageRuntimeContext(props.tabId)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    fileLinkContext,
    rootRef,
    { sessionId: props.sessionId, isVisible: props.isVisible }
  )
  const activeStoppingBackgroundTasks =
    stoppingBackgroundTasks?.sessionId === props.sessionId ? stoppingBackgroundTasks : null
  const prompt = controller.prompts[0] ?? null
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
  // Only the head of the outbox is ever dispatched, so it is the only entry a
  // Retry can act on and the only one whose state can be holding the queue.
  // Scanning past it named a message the user was not looking at and re-sent
  // one from earlier in the session while their newest sat behind it.
  const outboxHead = controller.outbox[0] ?? null
  const retryableOutboxEntry =
    outboxHead &&
    (outboxHead.state === 'unconfirmed' ||
      outboxHead.clientMessageId === controller.blockedClientMessageId)
      ? outboxHead
      : null
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
      {prompt?.body.kind === 'approval' ? (
        <NativeChatApprovalCard
          approval={{
            title: prompt.body.title,
            ...(prompt.body.detail ? { detail: prompt.body.detail } : {}),
            options: prompt.body.options.map((option) => ({
              label: option.label,
              send: option.id
            }))
          }}
          onChoose={(optionId) => void controller.respond(prompt, optionId)}
          onCancel={() => void controller.cancel(controller.turnId, prompt)}
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
          onCancel={() => {
            void controller.cancel(controller.turnId, prompt)
          }}
        />
      ) : null}
      {retryableOutboxEntry ? (
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-muted-foreground">
          <span>
            {retryableOutboxEntry.state === 'unconfirmed'
              ? translate(
                  'auto.components.native.chat.NativeChatStructuredSession.1f772bb5d0',
                  'Message delivery is unconfirmed.'
                )
              : translate(
                  'auto.components.native.chat.NativeChatStructuredSession.93ef441197',
                  'Message was not sent.'
                )}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => controller.retry(retryableOutboxEntry.clientMessageId)}
          >
            <RotateCcw className="size-3" />
            {translate(
              'auto.components.native.chat.NativeChatStructuredSession.a5e7f14068',
              'Retry'
            )}
          </Button>
        </div>
      ) : null}
      {controller.error || composerError ? (
        <p className="mx-auto w-full max-w-4xl px-4 py-1 text-xs text-destructive">
          {controller.error ?? composerError}
        </p>
      ) : null}
      {controller.backgroundTasks.show ? (
        <NativeChatBackgroundTasksStatus
          isVisible={props.isVisible}
          tasks={controller.backgroundTasks.tasks}
          settledTasks={controller.backgroundTasks.settledTasks}
          indicatorActive={controller.backgroundTasks.isMonitoring}
          supportsTaskStop={controller.backgroundTasks.supportsStop}
          supportsStopAll={controller.backgroundTasks.supportsStopAll}
          stoppingTaskIds={activeStoppingBackgroundTasks?.taskIds ?? NO_STOPPING_TASKS}
          stoppingAll={activeStoppingBackgroundTasks?.all ?? false}
          expanded={
            expandedBackgroundTasks?.sessionId === props.sessionId &&
            expandedBackgroundTasks.expanded
          }
          onExpandedChange={(expanded) =>
            setExpandedBackgroundTasks({ sessionId: props.sessionId, expanded })
          }
          onStop={(taskId) => {
            const targetSessionId = props.sessionId
            setStoppingBackgroundTasks((current) => {
              const taskIds = new Set(
                current?.sessionId === targetSessionId ? current.taskIds : NO_STOPPING_TASKS
              )
              if (taskId) {
                taskIds.add(taskId)
              }
              return {
                sessionId: targetSessionId,
                taskIds,
                all: taskId ? current?.sessionId === targetSessionId && current.all : true
              }
            })
            void controller.stopBackgroundTask(taskId).finally(() => {
              setStoppingBackgroundTasks((current) => {
                if (current?.sessionId !== targetSessionId) {
                  return current
                }
                const taskIds = new Set(current.taskIds)
                if (taskId) {
                  taskIds.delete(taskId)
                }
                const all = taskId ? current.all : false
                return taskIds.size === 0 && !all
                  ? null
                  : { sessionId: targetSessionId, taskIds, all }
              })
            })
          }}
        />
      ) : null}
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
