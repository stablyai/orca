/**
 * The one plain-text rendering of a worker transcript message.
 *
 * The CLI prints `worker-read --source transcript` with it, and `terminal read` serves a structured
 * worker's recent output through it, so a peer sees the same text either way. Shared rather than
 * copied: two renderings would let the two surfaces disagree about what a tool call looked like.
 */

import type { NativeChatMessage } from './native-chat-types'

export function formatWorkerTranscriptMessage(message: NativeChatMessage): string {
  const blocks = message.blocks.map((block) => {
    if (block.type === 'text') {
      return block.text
    }
    if (block.type === 'tool-call') {
      return `[tool ${block.name}] ${safeJson(block.input)}`
    }
    if (block.type === 'tool-result') {
      return `[tool result${block.isError ? ' error' : ''}] ${block.output}`
    }
    return block.url ? `[image] ${block.url}` : `[image omitted]`
  })
  return `[${message.role}] ${blocks.join('\n')}`.trimEnd()
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable input]'
  }
}
