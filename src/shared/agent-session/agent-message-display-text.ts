import type { AgentMessageSource } from './agent-session-message-source'
import type { NativeChatBlock } from '../native-chat-types'
import { nativeChatProseToMarkdown } from '../native-chat/transcript/native-chat-prose'
import { orcaDispatchTaskBodyOffset } from '../orca-dispatch-status-prompt'

const taskBodies = new WeakMap<readonly NativeChatBlock[], string | undefined>()

/** Display only: providers, queue editors and context readers retain the original input. */
export function agentMessageDisplayText(
  blocks: readonly NativeChatBlock[],
  from?: AgentMessageSource
): string | undefined {
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
  from?: AgentMessageSource
): string {
  return agentMessageDisplayText(blocks, from) ?? nativeChatProseToMarkdown(blocks)
}
