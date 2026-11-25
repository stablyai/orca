import { useState, type RefObject } from 'react'
import { agentSessionPromptQuestions } from '../../../../../shared/agent-session/requests/prompts/agent-session-question-answer'
import { structuredQuestionCard } from '../../../../../shared/native-chat/input/questions/structured-agent-question-card'
import { chatApprovalFromJournal } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { NativeChatApprovalCard } from './NativeChatApprovalCard'
import { NativeChatStructuredQuestionCard } from './NativeChatStructuredQuestionCard'
import { NativeChatPromptStrip } from './NativeChatPromptCollapse'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>
type PromptItem = Parameters<PromptResponse['holds']>[0]

/** The chat's own open prompt in the slot above the message box: an approval or a question card.
 *  Callers key it by prompt revision, so a new question arrives expanded. */
export function NativeChatStructuredPromptCard({
  prompt,
  promptResponse,
  onCancel,
  shouldFocus,
  answerInputRef
}: {
  prompt: PromptItem | null
  promptResponse: PromptResponse
  onCancel: () => void
  shouldFocus: boolean
  answerInputRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState(false)
  if (prompt?.body.kind === 'approval') {
    return (
      <NativeChatApprovalCard
        approval={chatApprovalFromJournal(prompt.body)}
        onChoose={(optionId) => void promptResponse.respond(prompt, { kind: 'option', optionId })}
        isSubmitting={promptResponse.holds(prompt)}
        onCancel={onCancel}
        shouldFocus={shouldFocus}
      />
    )
  }
  if (prompt?.body.kind === 'question') {
    const questions = agentSessionPromptQuestions(prompt.body)
    // Collapsing only frees transcript room; the composer stays away while the agent waits on the answer.
    return (
      <>
        <div
          data-native-chat-dock-contents
          hidden={collapsed}
          inert={collapsed}
          className="contents"
        >
          <NativeChatStructuredQuestionCard
            questions={questions}
            onAnswer={(response) => void promptResponse.respond(prompt, response)}
            isSubmitting={promptResponse.holds(prompt)}
            onCancel={onCancel}
            onCollapse={() => setCollapsed(true)}
            shouldFocus={shouldFocus && !collapsed}
            // Detached while collapsed so a paste cannot edit the hidden draft.
            answerInputRef={collapsed ? undefined : answerInputRef}
          />
        </div>
        {/* No composer follows the strip, so it keeps the card's bottom gutter. */}
        {collapsed ? (
          <div className="shrink-0 bg-chat-pane pb-4">
            <NativeChatPromptStrip
              card={{ kind: 'question', prompt: structuredQuestionCard(questions).prompt }}
              onExpand={() => setCollapsed(false)}
              takeFocus
            />
          </div>
        ) : null}
      </>
    )
  }
  return null
}
