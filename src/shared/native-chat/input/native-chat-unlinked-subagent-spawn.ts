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

function spawnMessage(host: NativeChatMessage, blocks: NativeChatBlock[]): NativeChatMessage {
  return {
    id: `spawn:${host.id}`,
    role: host.role,
    blocks,
    timestamp: host.timestamp,
    source: host.source
  }
}

/** A spawn card for each roster child no Agent, Task, or spawn call already names. */
export function linkUnrecordedSubagentSpawns(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const linked = linkedSpawnIds(messages)
  const next: NativeChatMessage[] = []
  let changed = false
  for (const message of messages) {
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
      }
    }
    // The roster row moves when an earlier sibling folds in, so the card stays its own row.
    if (cards.length > 0) {
      next.push(spawnMessage(message, cards))
      changed = true
    }
    next.push(message)
  }
  return changed ? next : (messages as NativeChatMessage[])
}

/** Desktop sections draw the card on the roster. A spawn: row would be a second slot. */
export function attachUnrecordedSpawnCards(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  const attached: NativeChatMessage[] = []
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!
    const host = messages[i + 1]
    if (host && message.id === `spawn:${host.id}`) {
      attached.push({ ...host, blocks: [...message.blocks, ...host.blocks] })
      i += 1
      continue
    }
    attached.push(message)
  }
  return attached
}
