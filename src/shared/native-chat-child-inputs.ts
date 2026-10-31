import { codexCollabRowAgentIds } from './codex-collab-agent-tools'
import {
  isTextBlock,
  isToolCallBlock,
  type NativeChatMessage,
  type NativeChatBlock
} from './native-chat-types'

export const RECORDED_PARENT_MESSAGE_SOURCE = {
  kind: 'agent',
  senders: [],
  orchestration: null
} as const

function parentCallBindings(
  messages: readonly NativeChatMessage[]
): ReadonlyMap<string, ReadonlySet<string>> {
  const bindings = new Map<string, Set<string>>()
  for (const message of messages) {
    if (message.agentId === undefined || !message.providerParentRef) {
      continue
    }
    const agents = bindings.get(message.providerParentRef) ?? new Set<string>()
    agents.add(message.agentId)
    bindings.set(message.providerParentRef, agents)
  }
  return bindings
}

function recordedInput(
  block: NativeChatBlock,
  bindings: ReadonlyMap<string, ReadonlySet<string>>
): { prompt: string; agents: string[] } | null {
  if (
    !isToolCallBlock(block) ||
    block.state === 'failed' ||
    !['Task', 'Agent', 'spawn_agent', 'send_input', 'send_message', 'followup_task'].includes(
      block.name
    )
  ) {
    return null
  }
  const input = block.input
  if (
    typeof input !== 'object' ||
    input === null ||
    !('prompt' in input) ||
    typeof input.prompt !== 'string' ||
    input.prompt.length === 0
  ) {
    return null
  }
  if (block.name === 'Task' || block.name === 'Agent') {
    const agents = block.callId ? bindings.get(block.callId) : undefined
    return agents?.size === 1 ? { prompt: input.prompt, agents: [...agents] } : null
  }
  return block.state === 'completed'
    ? { prompt: input.prompt, agents: codexCollabRowAgentIds(input) }
    : null
}

export function hasRecordedNativeChatChildAssignment(
  messages: readonly NativeChatMessage[],
  agentId?: string
): boolean {
  const bindings = parentCallBindings(messages)
  return agentId === undefined
    ? messages.some(
        (message) => message.role === 'user' && message.from?.orchestration?.message === 'task'
      )
    : messages.some((message) =>
        message.blocks.some(
          (block) =>
            isToolCallBlock(block) &&
            ['spawn_agent', 'Task', 'Agent'].includes(block.name) &&
            recordedInput(block, bindings)?.agents.includes(agentId)
        )
      )
}

/** Recover exact call prompts only with explicit recipients or canonical child-to-call linkage. */
export function nativeChatRecordedChildInputs(
  messages: readonly NativeChatMessage[],
  agentIds: ReadonlySet<string>
): {
  byParent: ReadonlyMap<string, readonly NativeChatMessage[]>
  authenticatedInputs: ReadonlySet<string>
} {
  const bindings = parentCallBindings(messages)
  const native = new Map<string, NativeChatMessage[]>()
  const promptKey = (agentId: string, text: string) => JSON.stringify([agentId, text])
  for (const message of messages) {
    if (
      message.role !== 'user' ||
      message.agentId === undefined ||
      !agentIds.has(message.agentId)
    ) {
      continue
    }
    const key = promptKey(
      message.agentId,
      message.blocks
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('')
    )
    const held = native.get(key) ?? []
    held.push(message)
    native.set(key, held)
  }
  const byParent = new Map<string, NativeChatMessage[]>()
  const authenticatedInputs = new Set<string>()
  const recorded = new Set<string>()
  for (const message of messages) {
    for (const [index, block] of message.blocks.entries()) {
      const input = recordedInput(block, bindings)
      if (!input || !isToolCallBlock(block)) {
        continue
      }
      for (const agentId of input.agents.filter((id) => agentIds.has(id))) {
        const existing = native.get(promptKey(agentId, input.prompt))?.shift()
        if (existing) {
          authenticatedInputs.add(existing.id)
          continue
        }
        const id = `recorded-child-input:${JSON.stringify([message.id, block.callId ?? index, agentId])}`
        if (recorded.has(id)) {
          continue
        }
        recorded.add(id)
        const inputs = byParent.get(message.id) ?? []
        inputs.push({
          id,
          role: 'user',
          agentId,
          producerKind: 'agent',
          ...(message.agentId ? { parentAgentId: message.agentId } : {}),
          blocks: [{ type: 'text', text: input.prompt }],
          timestamp: message.timestamp,
          source: message.source,
          ...(message.journalPosition ? { journalPosition: message.journalPosition } : {}),
          from: RECORDED_PARENT_MESSAGE_SOURCE
        })
        byParent.set(message.id, inputs)
      }
    }
  }
  return { byParent, authenticatedInputs }
}
