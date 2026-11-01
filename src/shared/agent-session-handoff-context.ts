import type {
  NativeChatMessage,
  NativeChatToolCallBlock,
  NativeChatToolResultBlock
} from './native-chat-types'
import { isWordlessProviderFrameBlock } from './native-chat/native-chat-provider-frame-summary'
import { pairToolBlocks, type NativeChatToolPair } from './native-chat/tools/native-chat-tool-pairs'
import { formatToolInputPreview } from './native-chat/tools/native-chat-tool-summary'
import { sliceAtCodeUnitLimit } from './surrogate-safe-text-slice'
import { MAX_CONTEXT_CHARS } from './agent-session-context-budget'
import { agentJournalToolCallLifecycle } from './agent-journal-tool-call-lifecycle'
import { withoutNativeChatVisualDirectiveLines } from './native-chat/native-chat-visual-directive'
import { workerTranscriptBlockFallbacks } from './worker-transcript-text'

const MAX_TOOL_CHARS = 8_000
const MAX_MESSAGE_CHARS = 8_000
const MAX_TOOL_INPUT_CHARS = 1_000
const MAX_TOOL_OUTPUT_CHARS = 2_000
const MIN_ENTRY_CHARS = 256
const OMISSION_MARKER = '[Orca: some saved chat messages or tool details omitted from this excerpt]'
const SHORTENING_MARKER = '\n[Orca: middle omitted]\n'

type ToolEvidencePart = { block: NativeChatToolCallBlock | NativeChatToolResultBlock; text: string }
type ContextEntry = { messageIndex: number; blockIndex: number; text: string }
type ConversationMessage = {
  messageIndex: number
  message: NativeChatMessage
  entries: ContextEntry[]
}

/** Budget conversation messages separately from tool evidence, then restore transcript order. */
export function buildAgentSessionHandoffContext(messages: readonly NativeChatMessage[]): string {
  const tools = selectToolEvidence(messages)
  const entries: ContextEntry[] = [...tools.entries]
  let remaining = MAX_CONTEXT_CHARS - contextEntryChars(entries) - OMISSION_MARKER.length - 2
  let omitted = false
  for (const candidate of prioritizeConversation(messages)) {
    if (remaining < MIN_ENTRY_CHARS) {
      omitted = true
      break
    }
    const limit = Math.min(MAX_MESSAGE_CHARS, remaining) - 2
    const selected = excerptConversation(candidate.entries, limit)
    entries.push(...selected.entries)
    remaining -= contextEntryChars(selected.entries)
    omitted ||= selected.shortened
  }

  entries.sort(
    (left, right) => left.messageIndex - right.messageIndex || left.blockIndex - right.blockIndex
  )
  if (!entries.length) {
    return ''
  }
  return [
    ...(omitted || tools.omitted ? [OMISSION_MARKER] : []),
    ...entries.map((entry) => entry.text)
  ].join('\n\n')
}

function contextEntryChars(entries: readonly { text: string }[]): number {
  return entries.reduce((chars, entry) => chars + entry.text.length + 2, 0)
}

function prioritizeConversation(messages: readonly NativeChatMessage[]): ConversationMessage[] {
  const candidates = messages.flatMap((message, messageIndex) => {
    if (message.agentStart || message.role === 'reasoning') {
      return []
    }
    const fallbacks = workerTranscriptBlockFallbacks(message.blocks)
    const entries = message.blocks.flatMap((block, blockIndex) => {
      let text = fallbacks.get(blockIndex) ?? ''
      if (block.type === 'text' && !isWordlessProviderFrameBlock(block)) {
        text =
          message.role === 'user' ? block.text : withoutNativeChatVisualDirectiveLines(block.text)
      } else if (block.type === 'image-ref') {
        text = `[image] ${excerpt(block.path ?? block.url ?? block.alt ?? 'image omitted', MAX_MESSAGE_CHARS / 2)}`
      }
      return text.trim() ? [{ messageIndex, blockIndex, text }] : []
    })
    if (!entries.length) {
      return []
    }
    const delivery = message.queued ? ' queued' : message.unsent ? ' unsent' : ''
    entries[0].text = `[${message.role}${delivery}] ${entries[0].text}`
    return [{ messageIndex, message, entries }]
  })
  const delivered = candidates.filter(({ message }) => !message.queued && !message.unsent)
  const latestUser = delivered.findLast(({ message }) => message.role === 'user')
  const latestAssistant = delivered.findLast(({ message }) => message.role === 'assistant')
  const priority = (candidate: ConversationMessage): number => {
    if (candidate === latestUser || candidate === latestAssistant) {
      return 0
    }
    return candidate.message.queued || candidate.message.unsent ? 2 : 1
  }
  return candidates.sort(
    (left, right) => priority(left) - priority(right) || right.messageIndex - left.messageIndex
  )
}

function selectToolEvidence(messages: readonly NativeChatMessage[]): {
  entries: ContextEntry[]
  omitted: boolean
} {
  const entries: ContextEntry[] = []
  let remaining = MAX_TOOL_CHARS
  let omitted = false
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
    const message = messages[messageIndex]
    if (message.agentStart || message.role === 'reasoning') {
      continue
    }
    if (
      !message.blocks.some((block) => block.type === 'tool-call' || block.type === 'tool-result')
    ) {
      continue
    }
    if (remaining < MIN_ENTRY_CHARS) {
      return { entries, omitted: true }
    }
    const pairs = pairToolBlocks(message.blocks)
    const blockIndices = new Map(message.blocks.map((block, index) => [block, index]))
    for (let index = pairs.length - 1; index >= 0; index--) {
      if (remaining < MIN_ENTRY_CHARS) {
        return { entries, omitted: true }
      }
      const pair = pairs[index]
      const formatted = formatToolPair(pair, remaining)
      omitted ||= formatted.shortened
      for (const { block, text } of formatted.parts) {
        const blockIndex = blockIndices.get(block)
        if (blockIndex !== undefined) {
          entries.push({ messageIndex, blockIndex, text })
        }
      }
      remaining -= contextEntryChars(formatted.parts)
    }
  }
  return { entries, omitted }
}

function excerptConversation(
  entries: readonly ContextEntry[],
  maxChars: number
): { entries: readonly ContextEntry[]; shortened: boolean } {
  const text = entries.map((entry) => entry.text).join('\n\n')
  if (text.length <= maxChars) {
    return { entries, shortened: false }
  }
  // Keep block positions so tool evidence stays between the surrounding prose.
  const { headEnd, tailStart } = excerptBounds(text, maxChars - 2)
  const head = sliceConversation(entries, 0, headEnd)
  const tail = sliceConversation(entries, tailStart, text.length)
  const lastHead = head.at(-1)
  if (lastHead) {
    lastHead.text += SHORTENING_MARKER
  }
  return { entries: [...head, ...tail], shortened: true }
}

function sliceConversation(
  entries: readonly ContextEntry[],
  start: number,
  end: number
): ContextEntry[] {
  let offset = 0
  return entries.flatMap((entry) => {
    const text = entry.text.slice(Math.max(0, start - offset), Math.max(0, end - offset))
    offset += entry.text.length + 2
    return text ? [{ ...entry, text }] : []
  })
}

function formatToolPair(
  pair: NativeChatToolPair,
  maxChars: number
): { parts: ToolEvidencePart[]; shortened: boolean } {
  const parts: ToolEvidencePart[] = []
  if (pair.call) {
    const call = pair.call
    const state = agentJournalToolCallLifecycle(call)
    parts.push({
      block: call,
      text: `[tool ${excerpt(call.name, 100)}${state ? ` ${state}` : ''} input preview] ${toolCallReference(call.callId)}`
    })
  }
  if (pair.result) {
    parts.push({
      block: pair.result,
      text: `[tool result${pair.result.isError ? ' error' : ''}] ${toolCallReference(pair.result.callId)}`
    })
  }
  let remaining = maxChars - contextEntryChars(parts)
  if (remaining < 0) {
    return { parts: [], shortened: true }
  }
  let shortened = Boolean(pair.call && excerpt(pair.call.name, 100) !== pair.call.name)
  for (const part of parts) {
    const input = part.block.type === 'tool-call'
    const value =
      part.block.type === 'tool-call' ? formatToolInputPreview(part.block.input) : part.block.output
    const limit = input
      ? Math.min(MAX_TOOL_INPUT_CHARS, pair.result ? Math.floor(remaining / 2) : remaining)
      : Math.min(MAX_TOOL_OUTPUT_CHARS, remaining)
    const preview = excerpt(value, limit)
    part.text += preview
    remaining -= preview.length
    shortened ||= preview !== value
  }
  return { parts, shortened }
}

function toolCallReference(callId: string | undefined): string {
  return callId ? `call=${excerpt(callId, 100)} ` : ''
}

function excerpt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value
  }
  if (maxChars < SHORTENING_MARKER.length) {
    return sliceAtCodeUnitLimit(value, maxChars)
  }
  const { headEnd, tailStart } = excerptBounds(value, maxChars)
  return value.slice(0, headEnd) + SHORTENING_MARKER + value.slice(tailStart)
}

function excerptBounds(value: string, maxChars: number): { headEnd: number; tailStart: number } {
  const available = Math.max(0, maxChars - SHORTENING_MARKER.length)
  const headEnd = sliceAtCodeUnitLimit(value, Math.ceil(available / 2)).length
  let tailStart = value.length - Math.floor(available / 2)
  const code = value.charCodeAt(tailStart)
  if (code >= 0xdc00 && code <= 0xdfff) {
    tailStart++
  }
  return { headEnd, tailStart }
}
