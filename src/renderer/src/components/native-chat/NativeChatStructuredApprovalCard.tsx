import { NativeChatApprovalCard, type NativeChatApprovalCardProps } from './NativeChatApprovalCard'
import { chatApprovalFromJournal } from '../../../../shared/native-chat-interactive-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type Response = ReturnType<typeof useStructuredPromptResponseHold>
type Prompt = Parameters<Response['respond']>[0]
export function NativeChatStructuredApprovalCard({
  prompt,
  response,
  ...props
}: Omit<NativeChatApprovalCardProps, 'approval' | 'onChoose' | 'onSubmitForm' | 'isSubmitting'> & {
  prompt: Prompt
  response: Response
}) {
  if (prompt.body.kind !== 'approval') {
    return null
  }
  return (
    <NativeChatApprovalCard
      {...props}
      approval={chatApprovalFromJournal(prompt.body)}
      onChoose={(optionId) => void response.respond(prompt, { kind: 'option', optionId })}
      onSubmitForm={(content) => void response.respond(prompt, { kind: 'form', content })}
      isSubmitting={response.holds(prompt)}
    />
  )
}
