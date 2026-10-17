import { translate } from '@/i18n/i18n'
import { useContext } from 'react'
import { NativeChatAsyncQuestionContext } from './native-chat-async-question-context'
import { NativeChatAsyncQuestions } from './NativeChatAsyncQuestions'

/** Pending questions stay within reach even when their transcript rows are not loaded. */
export function NativeChatPendingAsyncQuestions(): React.JSX.Element | null {
  const reply = useContext(NativeChatAsyncQuestionContext)
  if (!reply?.pendingQuestions?.length) {
    return null
  }
  return (
    <div className="max-h-64 shrink-0 space-y-2 overflow-y-auto scrollbar-sleek p-3">
      {reply.pendingQuestions.map((group) => (
        <div key={`${group.key}:${JSON.stringify(group.questions)}`}>
          <NativeChatAsyncQuestions questions={group.questions} />
          {group.omittedCount ? (
            <p className="text-sm text-foreground">
              {translate(
                'components.native-chat.question.morePending',
                'More pending questions are available in the transcript.'
              )}
            </p>
          ) : null}
        </div>
      ))}
    </div>
  )
}
