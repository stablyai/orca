import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { releaseNativeChatReceiptDependencies } from '../../../../../../../shared/native-chat/transcript/native-chat-pending-witnesses'
import {
  nativeChatSourcePosition,
  type NativeChatSourceBoundary
} from '../../../../../../../shared/native-chat/transcript/native-chat-source-receipts'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { setBoundedScopeCacheEntry } from '../../../../../../../shared/native-chat/native-chat-scope-cache'
import {
  NATIVE_CHAT_PENDING_SEND_LIMIT,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import type { NativeChatLaunchPrompt } from '@/components/native-chat/drafts/native-chat-launch-prompt'
import {
  advancedNativeChatUserContentCounts,
  assignNativeChatPendingOccurrence,
  matchingNativeChatUserContentCounts,
  nativeChatPendingContentKey
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-occurrence'

export type NativeChatPendingSendScope = {
  paneKey: string
  agent: string
}

type PendingOwner = {
  pending: NativeChatPendingSend[]
  boundary?: NativeChatSourceBoundary
  sessionId?: string
}
const pendingSendCache = new Map<string, PendingOwner>()
let pendingSendCounter = 0

function pendingSendScopeKey(scope: NativeChatPendingSendScope): string {
  return `${scope.paneKey}\0${scope.agent}`
}

export function readPendingSendCache(scope: NativeChatPendingSendScope): NativeChatPendingSend[] {
  return pendingSendCache.get(pendingSendScopeKey(scope))?.pending ?? []
}

export function writePendingSendCache(
  scope: NativeChatPendingSendScope,
  pending: NativeChatPendingSend[]
): NativeChatPendingSend[] {
  const next = releaseNativeChatReceiptDependencies(pending.slice(-NATIVE_CHAT_PENDING_SEND_LIMIT))
  const key = pendingSendScopeKey(scope)
  const owner = pendingSendCache.get(key)
  setBoundedScopeCacheEntry(pendingSendCache, key, { ...owner, pending: next })
  return next
}

/** Retain the last observed source frontier through empty drains and older paged snapshots. */
export function observePendingSendCache(
  scope: NativeChatPendingSendScope,
  messages: readonly NativeChatMessage[],
  sessionId: string
): void {
  const key = pendingSendScopeKey(scope)
  const owner = pendingSendCache.get(key) ?? { pending: [] }
  const previous = owner.sessionId === sessionId ? owner.boundary : undefined
  const last = messages.at(-1)
  const message = last?.source === 'transcript' ? last : undefined
  if (!message) {
    if (owner.sessionId !== sessionId) {
      setBoundedScopeCacheEntry(pendingSendCache, key, { ...owner, sessionId, boundary: undefined })
    }
    return
  }
  const position = nativeChatSourcePosition(message)
  if (
    previous?.id === message.id &&
    previous.position?.kind === position?.kind &&
    previous.position?.value === position?.value
  ) {
    return
  }
  let advances = !previous
  if (previous) {
    if (position && previous.position?.kind === position.kind) {
      advances = position.value > previous.position.value
    } else {
      for (let index = messages.length - 2; index >= 0; index--) {
        if (messages[index].id === previous.id) {
          advances = true
          break
        }
      }
    }
  }
  if (owner.sessionId !== sessionId || (message && advances)) {
    setBoundedScopeCacheEntry(pendingSendCache, key, {
      ...owner,
      sessionId,
      boundary:
        message && advances
          ? { sessionId, id: message.id, timestamp: message.timestamp, position }
          : previous
    })
  }
}

export function appendPendingSendCache(
  scope: NativeChatPendingSendScope,
  entry: NativeChatPendingSend,
  activeSessionId?: string | null
): NativeChatPendingSend[] {
  const requestKey = (input: NativeChatPendingSend) =>
    JSON.stringify([input.text, input.imagePaths ?? []])
  const contentKey = requestKey(entry)
  // Why: a resend replaces its failed copy; kept, that copy would claim the resend's row and pin it.
  const existing = readPendingSendCache(scope).filter(
    (candidate) => !candidate.delivery || requestKey(candidate) !== contentKey
  )
  const owner = pendingSendCache.get(pendingSendScopeKey(scope))
  const boundary = owner?.boundary
  const captured =
    entry.sourceAgent &&
    boundary &&
    (activeSessionId === undefined || boundary.sessionId === activeSessionId) &&
    (!entry.afterEmptyTranscriptSessionId ||
      entry.afterEmptyTranscriptSessionId === boundary.sessionId)
      ? {
          ...entry,
          sourceBoundary: boundary,
          afterMessageId: boundary.id,
          afterMessageTimestamp: boundary.timestamp,
          afterEmptyTranscriptSessionId: undefined
        }
      : entry
  const next = entry.sourceAgent ? captured : assignNativeChatPendingOccurrence(existing, captured)
  return writePendingSendCache(scope, [...existing, next])
}

export function resolvePendingSendEvidence(
  entries: NativeChatPendingSend[],
  id: string,
  agent: AgentType,
  source?: boolean
): NativeChatPendingSend[] {
  const index = entries.findIndex((entry) => entry.id === id && entry.evidenceModePending)
  if (index === -1) {
    return entries
  }
  const entry = entries[index]
  const resolved = {
    ...entry,
    sourceAgent: source === undefined ? entry.sourceAgent : source ? agent : undefined,
    evidenceModePending: undefined
  }
  const key = nativeChatPendingContentKey(resolved)
  const before = entries
    .slice(0, index)
    .filter(
      (previous) =>
        source !== false ||
        previous.sourceAgent ||
        !previous.delivery ||
        nativeChatPendingContentKey(previous) !== key
    )
  const next =
    source === false
      ? assignNativeChatPendingOccurrence(
          before.filter((previous) => !previous.sourceAgent),
          resolved
        )
      : resolved
  return [...before, next, ...entries.slice(index + 1)]
}

export function clearPendingSendCacheForTests(): void {
  pendingSendCache.clear()
  pendingSendCounter = 0
}

// Synthetic launch ids never match real turns; reconcile normalized user text instead.
export function launchPromptAsMessage(
  entry: NativeChatLaunchPrompt | null,
  existingMessages: NativeChatMessage[] = []
): NativeChatMessage | null {
  if (!entry) {
    return null
  }
  // A new session’s timestampless matching row can only represent its launch prompt.
  const represented = matchingNativeChatUserContentCounts(
    existingMessages.filter(
      (message) => message.timestamp === null || message.timestamp >= entry.createdAt
    )
  )
  if ((represented.get(nativeChatPendingContentKey(entry)) ?? 0) > 0) {
    return null
  }
  return {
    id: `launch-pending:${entry.tabId}`,
    role: 'user' as const,
    blocks: entry.text.trim().length > 0 ? [{ type: 'text' as const, text: entry.text }] : [],
    timestamp: entry.createdAt,
    source: 'scrape' as const
  }
}

// Wait for a later non-user turn to avoid a first-turn flash before the transcript catches up.
export function shouldPruneLaunchPrompt(
  entry: NativeChatLaunchPrompt,
  messages: NativeChatMessage[]
): boolean {
  const relevant = messages.filter(
    (message) => message.timestamp === null || message.timestamp >= entry.createdAt
  )
  return (
    (advancedNativeChatUserContentCounts(relevant).get(nativeChatPendingContentKey(entry)) ?? 0) > 0
  )
}

export function nextNativeChatPendingSendId(now = Date.now()): string {
  pendingSendCounter += 1
  return `${now}-${pendingSendCounter}`
}
