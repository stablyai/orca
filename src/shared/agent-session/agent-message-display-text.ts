import type { AgentMessageSource } from './agent-session-message-source'
import { orchestrationMailDisplayText } from './orchestration-mail-display-text'
import type { NativeChatBlock } from '../native-chat/native-chat-types'
import { nativeChatProseToMarkdown } from '../native-chat/transcript/row-content/native-chat-prose'
import { orcaDispatchTaskBodyOffset } from '../orca-dispatch-status-prompt'

const taskBodies = new WeakMap<readonly NativeChatBlock[], string | undefined>()
const mailBodies = new WeakMap<
  readonly NativeChatBlock[],
  { key: string; text: string | undefined }
>()

/** Display only: providers, queue editors and context readers retain the original input. */
export function agentMessageDisplayText(
  blocks: readonly NativeChatBlock[],
  from?: AgentMessageSource,
  shortened = false
): string | undefined {
  if (from?.orchestration?.message === 'mail-notice') {
    const mail = from.orchestration.messages
    if (mail.length !== 1 || blocks.length !== 1 || blocks[0].type !== 'text') {
      return undefined
    }
    const key = JSON.stringify([mail[0].messageId, mail[0].from, mail[0].content, shortened])
    const cached = mailBodies.get(blocks)
    if (cached?.key === key) {
      return cached.text
    }
    const text = orchestrationMailDisplayText(blocks[0].text, mail[0], shortened)
    mailBodies.set(blocks, { key, text })
    return text
  }
  if (from?.orchestration?.message !== 'task') {
    return undefined
  }
  if (taskBodies.has(blocks)) {
    return taskBodies.get(blocks)
  }
  if (blocks.some((block) => block.type !== 'text' && block.type !== 'image-ref')) {
    taskBodies.set(blocks, undefined)
    return undefined
  }
  const texts = blocks.filter((block) => block.type === 'text')
  const text = texts.length === 1 ? texts[0].text : undefined
  const offset = text === undefined ? undefined : orcaDispatchTaskBodyOffset(text)
  const body = offset === undefined ? undefined : text?.slice(offset)
  taskBodies.set(blocks, body)
  return body
}

export function agentMessageTranscriptText(
  blocks: NativeChatBlock[],
  from?: AgentMessageSource,
  shortened = false
): string {
  return agentMessageDisplayText(blocks, from, shortened) ?? nativeChatProseToMarkdown(blocks)
}
