// Codex records a finished child on the roster and may never store spawn_agent.
// The card is the same link the roster row uses, with the task name and no sealed prompt.

import {
  isSubagentGroupBlock,
  type NativeChatBlock,
  type NativeChatMessage,
  type NativeChatSubagentState
} from '../native-chat-types'
import { pairToolBlocks } from '../tools/native-chat-tool-pairs'
import { nativeChatSpawnedSubagentId } from './native-chat-subagent-brief'

function linkedSpawnIds(messages: readonly NativeChatMessage[]): Set<string> {
  const linked = new Set<string>()
  for (const message of messages) {
    for (const pair of pairToolBlocks(message.blocks)) {
      const id = pair.call ? nativeChatSpawnedSubagentId(pair.call.name, pair.result) : null
      if (id) {
        linked.add(id)
      }
    }
  }
  return linked
}

function spawnCard(
  agentId: string,
  label: string,
  state: NativeChatSubagentState
): NativeChatBlock[] {
  const callId = `spawn:${agentId}`
  return [
    {
      type: 'tool-call',
      name: 'spawn_agent',
      callId,
      state: 'completed',
      input: { task_name: label }
    },
    {
      type: 'tool-result',
      callId,
      output: '',
      subagent: { id: agentId, state }
    }
  ]
}

/** A spawn card for each roster child no Agent, Task, or spawn call already names. */
export function linkUnrecordedSubagentSpawns(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const linked = linkedSpawnIds(messages)
  let changed = false
  const next = messages.map((message) => {
    const cards: NativeChatBlock[] = []
    for (const block of message.blocks) {
      if (!isSubagentGroupBlock(block)) {
        continue
      }
      for (const agent of block.agents) {
        if (!agent.id || linked.has(agent.id)) {
          continue
        }
        linked.add(agent.id)
        cards.push(...spawnCard(agent.id, agent.label || agent.id, agent.state))
        changed = true
      }
    }
    return cards.length === 0 ? message : { ...message, blocks: [...cards, ...message.blocks] }
  })
  return changed ? next : (messages as NativeChatMessage[])
}
