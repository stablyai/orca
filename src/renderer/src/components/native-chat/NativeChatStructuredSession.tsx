import { useMemo, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import { encodeAgentSessionQuestionAnswers } from '../../../../shared/agent-session-question-answer'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer } from './NativeChatComposer'
import { NativeChatEmptyState } from './NativeChatEmptyState'
import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import { selectNativeChatViewState } from './native-chat-view-state'
import { useNativeChatFontScale } from './use-native-chat-font-scale'
import { useNativeChatFileLinkClick } from './use-native-chat-file-link-click'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { translate } from '@/i18n/i18n'
import { StructuredAgentSessionHandoffChrome } from './StructuredAgentSessionHandoffChrome'

function encodeQuestionAnswer(questionId: string, answer: string): string {
  return `${encodeURIComponent(questionId)}:${encodeURIComponent(answer)}`
}

export function NativeChatStructuredSession(props: {
  tabId: string
  sessionId: string
  target: RuntimeClientTarget
  agent: AgentType
  allowFileUriLinks: boolean
}): React.JSX.Element {
  const controller = useStructuredAgentSession(props)
  const [composerError, setComposerError] = useState<string | null>(null)
  const paneKey = useMemo(
    () => structuredAgentSessionPaneKey(props.tabId, props.sessionId),
    [props.sessionId, props.tabId]
  )
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
  const fileLinkClick = useNativeChatFileLinkClick(props.allowFileUriLinks ? fileLinkContext : null)
  const prompt = controller.prompts[0] ?? null
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
  const retryableOutboxEntry =
    controller.outbox.find((entry) => entry.state === 'unconfirmed') ??
    controller.outbox.find(
      (entry) => entry.clientMessageId === controller.blockedClientMessageId
    ) ??
    null
  const structuredTransport = useMemo(
    () => ({
      send: controller.send,
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: props.agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async () => false,
          setOption: controller.setStructuredOption
        }),
      optionsSurface: controller.optionSurface,
      optionSnapshot: controller.optionSnapshot,
      onError: setComposerError,
      runtime: (props.target.kind === 'local' ? 'local' : 'remote') as 'local' | 'remote'
    }),
    [controller, props.agent, props.target.kind]
  )

  return (
    <div
      data-native-chat-root="true"
      tabIndex={-1}
      className="flex h-full min-h-0 w-full flex-col bg-background focus:outline-none"
    >
      <StructuredAgentSessionHandoffChrome
        status={controller.handoff}
        isWorking={controller.isWorking}
        onRequest={(direction, mode, action) => {
          void controller.requestHandoff(direction, mode, action)
        }}
      />
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
            isWorking={controller.isWorking}
            expandSignal={false}
            fontScale={fontScale.scale}
            onLinkClick={fileLinkClick}
            allowFileUriLinks={fileLinkClick !== undefined}
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
            if (controller.turnId) {
              void controller.cancel(controller.turnId)
            }
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
      {prompt ||
      controller.handoff?.owner === 'tui' ||
      controller.handoff?.phase === 'switching' ? null : (
        <NativeChatComposer
          terminalTabId={props.tabId}
          paneKey={paneKey}
          targetPtyId={null}
          agent={props.agent}
          canSend={!prompt}
          isWorking={controller.isWorking}
          onStop={() => {
            if (controller.turnId) {
              void controller.cancel(controller.turnId)
            }
          }}
          structuredTransport={structuredTransport}
        />
      )}
    </div>
  )
}
