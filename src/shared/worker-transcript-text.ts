/**
 * The one plain-text rendering of a worker transcript message.
 *
 * The CLI prints `worker-read --source transcript` with it, and `terminal read` serves a structured
 * worker's recent output through it, so a peer sees the same text either way. Shared rather than
 * copied: two renderings would let the two surfaces disagree about what a tool call looked like.
 */

import {
  isSubagentGroupFallbackText,
  subagentGroupFallbackText
} from './native-chat-subagent-summary'
import type { NativeChatMessage } from './native-chat-types'

export function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  // Every roster block is written beside a plain-text twin carrying the same
  // sentence, for clients that cannot draw the block. Text surfaces are those
  // clients, so they print the twin and drop the block. The renderer reaches the
  // same single print from the other side but not by the same rule: it drops
  // every fallback-shaped text block as soon as any group is present and draws
  // each group, so it never has to decide which twin belongs to which group.
  const standIns = claimSubagentGroupTwins(message.blocks)
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
    if (block.type === 'subagent-group') {
      return standIns.get(index) ?? null
    }
    // The journal deliberately admits block types this build does not know, and
    // a newer remote host can send one over the wire. Degrade to a marker rather
    // than reading fields off a shape that has none.
    return '[unsupported block]'
  })
  return `[${message.role}] ${blocks.filter((line) => line !== null).join('\n')}`.trimEnd()
}

/** For each roster block, the sentence it must print itself — absent when a twin
 *  beside it already prints one.
 *
 *  Exact-text claims are settled for EVERY group before any leftover twin is
 *  claimed by position: claiming in block order let an earlier group consume a
 *  later group's twin, silencing the earlier roster while the later one printed
 *  twice. The positional fallback stays because a roster written by a newer build
 *  holds a state this build reads as `unverifiable`, so its frozen twin can never
 *  equal the sentence recomputed here and a text match alone would print it
 *  twice. A group left with no twin prints its own: the wire admits a roster that
 *  arrived without one, and dropping that would lose the sentence altogether. */
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
