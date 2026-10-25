import {
  isTextBlock,
  NATIVE_CHAT_SOURCE_PRIORITY,
  type AgentType,
  type NativeChatMessage,
  type NativeChatSession,
  type NativeChatSessionStatus
} from '../../../../shared/native-chat-types'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat/native-chat-streaming'
import { compareNativeChatTranscriptMessages } from '../../../../shared/native-chat-transcript-projection'
import {
  hasImagePromptMarker,
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages
} from '../../../../shared/native-chat-image-transcript-markers'
import { isLaunchPromptMessageId, isPendingMessageId } from './native-chat-pending'

/** For the same turn, prefer transcript over hook over scrape. */
export type NativeChatSources = {
  transcript?: NativeChatMessage[]
  hook?: NativeChatMessage[]
  scrape?: NativeChatMessage[]
}

export type AssembleNativeChatSessionInput = {
  sources: NativeChatSources
  sessionId: string | null
  agent: AgentType
  /** Without an override, surviving messages mean ready and no messages mean empty. */
  status?: NativeChatSessionStatus
  error?: string
}

// Deduplicate explicit turn ids or normalized content only across sources; omit timestamps because scrape copies lack them.
function turnKey(message: NativeChatMessage): string {
  if (message.turnId) {
    return `turn:${message.turnId}`
  }
  const text = message.blocks
    .filter(isTextBlock)
    .map((block) => block.text)
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
  // Digest non-text blocks so distinct tool-only turns cannot share an empty-content key.
  return `${message.role}:${text}:${nonTextBlockDigest(message)}`
}

function nonTextBlockDigest(message: NativeChatMessage): string {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'tool-call') {
      parts.push(`call:${block.name}:${stableStringify(block.input)}`)
    } else if (block.type === 'tool-result') {
      parts.push(`result:${block.output}`)
    } else if (block.type === 'image-ref') {
      parts.push(`image:${block.path ?? block.url ?? block.alt ?? ''}`)
    }
  }
  return parts.join('|')
}

function stableStringify(value: unknown): string {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function supersedes(candidate: NativeChatMessage, existing: NativeChatMessage): boolean {
  const candidateRank = NATIVE_CHAT_SOURCE_PRIORITY[candidate.source]
  const existingRank = NATIVE_CHAT_SOURCE_PRIORITY[existing.source]
  return candidateRank > existingRank
}

// Sort real content before streaming preview before optimistic/queued sends, regardless of timestamps.
function messageSortRank(message: NativeChatMessage): number {
  if (message.id === NATIVE_CHAT_STREAMING_ID) {
    return 1
  }
  if (message.queued || isPendingMessageId(message.id) || isLaunchPromptMessageId(message.id)) {
    return 2
  }
  return 0
}

export function compareMessages(a: NativeChatMessage, b: NativeChatMessage): number {
  const ar = messageSortRank(a)
  const br = messageSortRank(b)
  if (ar !== br) {
    return ar - br
  }
  return compareNativeChatTranscriptMessages(a, b)
}

export function assembleNativeChatSession(
  input: AssembleNativeChatSessionInput
): NativeChatSession {
  const { sources, sessionId, agent, status, error } = input

  // Prefer higher-priority sources; sort before image folding to preserve equal-time companion/prompt order.
  const ordered: NativeChatMessage[] = [
    ...normalizeImageTranscriptMessages(sortForImageNormalization(sources.transcript ?? [])),
    ...(sources.hook ?? []),
    ...normalizeImageTranscriptMessages(sortForImageNormalization(sources.scrape ?? []))
  ]

  const byId = new Map<string, NativeChatMessage>()
  const byTurn = new Map<string, NativeChatMessage>()

  for (const message of ordered) {
    mergeOne(byId, byTurn, message)
  }

  const messages = Array.from(byId.values()).sort(compareMessages)

  const derivedStatus: NativeChatSessionStatus = messages.length === 0 ? 'empty' : 'ready'

  return {
    messages,
    status: status ?? derivedStatus,
    sessionId,
    agent,
    ...(error ? { error } : {})
  }
}

type ImageNormalizationUnit = {
  messages: NativeChatMessage[]
  sortKey: NativeChatMessage
}

// Keep adjacent image companion/prompt pairs atomic; global companion ranking could cross-fold equal-time turns.
export function sortForImageNormalization(
  messages: readonly NativeChatMessage[]
): readonly NativeChatMessage[] {
  const units: ImageNormalizationUnit[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!
    const companions: NativeChatMessage[] = []
    let prompt: NativeChatMessage | undefined

    if (isImageSourceUserTurn(message)) {
      let nextIndex = index
      while (
        nextIndex < messages.length &&
        messages[nextIndex]?.source === message.source &&
        isImageSourceUserTurn(messages[nextIndex]!)
      ) {
        companions.push(messages[nextIndex]!)
        nextIndex += 1
      }
      const candidate = messages[nextIndex]
      if (
        candidate?.role === 'user' &&
        candidate.source === message.source &&
        hasImagePromptMarker(candidate)
      ) {
        prompt = candidate
        index = nextIndex
      } else {
        companions.length = 0
      }
    } else {
      const candidate = messages[index + 1]
      if (
        message.role === 'user' &&
        hasImagePromptMarker(message) &&
        candidate?.source === message.source &&
        candidate.timestamp === message.timestamp &&
        isImageSourceUserTurn(candidate)
      ) {
        let nextIndex = index + 1
        while (
          nextIndex < messages.length &&
          messages[nextIndex]?.source === message.source &&
          messages[nextIndex]?.timestamp === message.timestamp &&
          isImageSourceUserTurn(messages[nextIndex]!)
        ) {
          companions.push(messages[nextIndex]!)
          nextIndex += 1
        }
        prompt = message
        index = nextIndex - 1
      }
    }

    const unitMessages = prompt ? [...companions, prompt] : [message]
    units.push({ messages: unitMessages, sortKey: prompt ?? message })
  }

  units.sort((a, b) => compareMessages(a.sortKey, b.sortKey))
  const sorted = units.flatMap((unit) => unit.messages)
  return sorted.every((message, index) => message === messages[index]) ? messages : sorted
}

/** Share id-first, cross-source turn-key deduplication between full and incremental assembly. */
export function mergeOne(
  byId: Map<string, NativeChatMessage>,
  byTurn: Map<string, NativeChatMessage>,
  message: NativeChatMessage
): void {
  const existingById = byId.get(message.id)
  if (existingById) {
    if (supersedes(message, existingById)) {
      replace(byId, byTurn, existingById, message)
    }
    return
  }
  const key = turnKey(message)
  const existingByTurn = byTurn.get(key)
  if (existingByTurn && existingByTurn.source !== message.source) {
    if (supersedes(message, existingByTurn)) {
      replace(byId, byTurn, existingByTurn, message)
    }
    return
  }
  // One same-key representative suffices for cross-source lookup; byId retains distinct same-source rows.
  byId.set(message.id, message)
  byTurn.set(key, message)
}

function replace(
  byId: Map<string, NativeChatMessage>,
  byTurn: Map<string, NativeChatMessage>,
  old: NativeChatMessage,
  next: NativeChatMessage
): void {
  byId.delete(old.id)
  byTurn.delete(turnKey(old))
  byId.set(next.id, next)
  byTurn.set(turnKey(next), next)
}
