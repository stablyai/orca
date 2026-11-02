/** Share worker-read transcript and terminal-read text rendering so peers see identical tool-call output through either surface. */

import { claimBackgroundTaskTwins } from './native-chat/input/native-chat-background-task-row'
import {
  isSubagentGroupFallbackText,
  subagentGroupFallbackText
} from './native-chat/transcript/native-chat-subagent-summary'
import { subagentFallbackText } from './native-chat/transcript/native-chat-subagent-items'
import type { NativeChatMessage } from './native-chat/native-chat-types'

export function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  const fallbacks = workerTranscriptBlockFallbacks(message.blocks)
  const blocks = message.blocks.map((block, index) => {
    if (block.type === 'text') {
      return block.text
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
    if (
      block.type === 'background-task' ||
      block.type === 'subagent-group' ||
      block.type === 'subagent'
    ) {
      return fallbacks.get(index) ?? null
    }
    // Newer hosts may send unknown journal blocks; emit a marker instead of reading nonexistent fields.
    return '[unsupported block]'
  })
  return `[${message.role}] ${blocks.filter((line) => line !== null).join('\n')}`.trimEnd()
}

/** Plain-text stand-ins for structured blocks that have no frozen text twin. */
export function workerTranscriptBlockFallbacks(
  blocks: NativeChatMessage['blocks']
): ReadonlyMap<number, string> {
  const fallbacks = claimSubagentGroupTwins(blocks)
  for (const [index, text] of claimBackgroundTaskTwins(blocks).unpairedRows) {
    fallbacks.set(index, text)
  }
  if (!blocks.some((block) => block.type === 'text')) {
    blocks.forEach((block, index) => {
      if (block.type === 'subagent') {
        fallbacks.set(index, `[subagents] ${subagentFallbackText(block)}`)
      }
    })
  }
  return fallbacks
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
