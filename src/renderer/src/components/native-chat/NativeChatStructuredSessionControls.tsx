import type { RefObject } from 'react'
import type { AgentSessionFailureFact } from '../../../../shared/agent-session-failure'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatComposer, type NativeChatComposerHandle } from './NativeChatComposer'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { NativeChatStructuredSessionStatus } from './NativeChatStructuredSessionStatus'
import { NativeChatInterruptedContinue } from './NativeChatInterruptedContinue'
import { NativeChatQueuedMessageList } from './NativeChatQueuedMessageList'
import { NativeChatThreadGoalBanner } from './NativeChatThreadGoalBanner'
import { NativeChatPromptSlotNotices } from './NativeChatComposerNotices'
import { structuredAgentSessionDraftScopeKey } from './native-chat-composer-draft-store'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { useNativeChatInterruptedContinuation } from './NativeChatInterruptedContinue'
import type { useStructuredNativeChatSubmitReveal } from './use-structured-native-chat-submit-reveal'
import type { useNativeChatRewindHost } from './use-native-chat-rewind-host'
import type { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import { chatApprovalFromJournal } from './native-chat-interactive-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'
import { agentSessionPromptQuestions } from '../../../../shared/agent-session-question-answer'
import type { useNativeChatLaunchDraftSignal } from './use-native-chat-launch-draft-adoption'
import type { useStructuredChatLiveSession } from './use-structured-chat-live-session'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'

type Controller = ReturnType<typeof useStructuredAgentSession>

export function NativeChatStructuredSessionControls({
  props,
  chatWorktreeId,
  agentLabel,
  startFailures,
  composerRef,
  questionAnswerInputRef,
  continuation,
  submits,
  focusComposer,
  paneKey,
  controller,
  stopControls,
  composerShown,
  notices,
  prompt,
  promptResponse,
  structuredTransport,
  launchDraftSignal,
  session,
  promptsUnanswerable,
  onLinkClick
}: {
  props: Omit<NativeChatStructuredViewProps, 'mode'>
  chatWorktreeId: string | null
  agentLabel: string
  startFailures: readonly AgentSessionFailureFact[]
  composerRef: RefObject<NativeChatComposerHandle | null>
  questionAnswerInputRef: RefObject<HTMLInputElement | null>
  continuation: ReturnType<typeof useNativeChatInterruptedContinuation>
  submits: ReturnType<typeof useStructuredNativeChatSubmitReveal>
  focusComposer: ReturnType<typeof useNativeChatRewindHost>['focusComposer']
  paneKey: string
  controller: Controller
  stopControls: ReturnType<typeof nativeChatStructuredStopControls>
  composerShown: boolean
  notices: NativeChatComposerNotice[]
  prompt: Controller['prompts'][number] | null
  promptResponse: ReturnType<typeof useStructuredPromptResponseHold>
  structuredTransport: NativeChatStructuredComposerTransport
  launchDraftSignal: ReturnType<typeof useNativeChatLaunchDraftSignal>
  session: ReturnType<typeof useStructuredChatLiveSession>
  promptsUnanswerable: boolean
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  const approval = prompt?.body.kind === 'approval' ? chatApprovalFromJournal(prompt.body) : null
  const questionBody = prompt?.body.kind === 'question' ? prompt.body : null
  const questions = questionBody ? agentSessionPromptQuestions(questionBody) : []
  const cancelPrompt = () => {
    if (prompt && (controller.turnId || props.agent === 'pi')) {
      void controller.cancel(controller.turnId ?? undefined, {
        itemId: prompt.itemId,
        expectedRevision: prompt.revision
      })
    }
  }
  return (
    <>
      <NativeChatInterruptedContinue continuation={continuation} />
      {/* Host-held drafts, never transcript rows. Above the status area, so running shells and agents sit next to the composer. */}
      <NativeChatQueuedMessageList
        controller={submits.queuedMessages}
        chatWorktreeId={chatWorktreeId}
        agentName={agentLabel}
        statedFailures={startFailures}
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
            controller.turnId === null ? null : { startedAt: controller.workingStartedAt ?? null }
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
          onChoose={(optionId) => void promptResponse.respond(prompt, { kind: 'option', optionId })}
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
  )
}
