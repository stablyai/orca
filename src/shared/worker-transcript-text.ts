/** Share worker-read transcript and terminal-read text rendering so peers see identical tool-call output through either surface. */

import { claimBackgroundTaskTwins } from './native-chat/input/native-chat-background-task-row'
import {
  isSubagentGroupFallbackText,
  subagentGroupFallbackText
} from './native-chat/transcript/native-chat-subagent-summary'
import { subagentFallbackText } from './native-chat/transcript/native-chat-subagent-items'
import type { NativeChatMessage } from './native-chat-types'

export function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  // Print roster text twins instead of blocks. Renderer uses the inverse presentation rule (draw groups, hide fallback-shaped text).
  const standIns = claimSubagentGroupTwins(message.blocks)
  // Background-task twins require exact text: provider sentences have no reliable fallback shape.
  const taskTwins = claimBackgroundTaskTwins(message.blocks)
  const blocks = message.blocks.map((block, index) => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'background-task') {
      return taskTwins.unpairedRows.get(index) ?? null
    }
    if (block.type === 'tool-call') {
      return `[tool ${block.name}] ${safeJson(block.input)}`
    }
    if (block.type === 'tool-result') {
      return `[tool result${block.isError ? ' error' : ''}] ${block.output}`
    }
    if (block.type === 'image-ref') {
      return block.url ? `[image] ${block.url}` : `[image omitted]`
    }
    if (block.type === 'subagent-group') {
      return standIns.get(index) ?? null
    }
    if (block.type === 'subagent') {
      // A subagent's own row is its block and its twin, nothing else.
      return message.blocks.some((other) => other.type === 'text')
        ? null
        : `[subagents] ${subagentFallbackText(block)}`
    }
    // Newer hosts may send unknown journal blocks; emit a marker instead of reading nonexistent fields.
    return '[unsupported block]'
  })
  return `[${message.role}] ${blocks.filter((line) => line !== null).join('\n')}`.trimEnd()
}

/** Claim exact twins for every roster before positional fallback, or an earlier group can steal a later group’s twin.
 * Keep positional matching for newer/unverifiable states whose frozen wording differs; groups with no twin must print their own sentence. */
function claimSubagentGroupTwins(blocks: NativeChatMessage['blocks']): Map<number, string> {
  const twins = new Map<string, number>()
  let remainingTwins = 0
  const groups: { index: number; sentence: string }[] = []
  blocks.forEach((block, index) => {
    if (block.type === 'text' && isSubagentGroupFallbackText(block.text)) {
      twins.set(block.text, (twins.get(block.text) ?? 0) + 1)
      remainingTwins += 1
    } else if (block.type === 'subagent-group') {
      groups.push({ index, sentence: subagentGroupFallbackText(block.agents) })
    }
  })
  const standIns = new Map<number, string>()
  const unclaimed = groups.filter((group) => {
    const count = twins.get(group.sentence) ?? 0
    if (count === 0) {
      return true
    }
    twins.set(group.sentence, count - 1)
    remainingTwins -= 1
    return false
  })
  for (const group of unclaimed) {
    if (remainingTwins > 0) {
      remainingTwins -= 1
      continue
    }
    standIns.set(group.index, `[subagents] ${group.sentence}`)
  }
  return standIns
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}
