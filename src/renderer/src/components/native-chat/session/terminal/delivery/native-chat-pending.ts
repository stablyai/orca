import { isSameAgentProcess } from '../../../../../../../shared/agent-status/process/agent-process-presence'
import type {
  NativeChatPromptSubmission,
  NativeChatSourceContext
} from '../../../../../../../shared/native-chat/input/native-chat-prompt-observation'
import { nativeChatSourcePendingKeys } from '../../../../../../../shared/native-chat/transcript/native-chat-input-content-key'
import type { IncrementalChatAssembler } from '../assembly/native-chat-incremental-assembler'
import {
  nativeChatSourcePosition,
  canClaimNativeChatReceipt,
  releaseNativeChatReceiptDependencies,
  type NativeChatSourceBoundary
} from '../../../../../../../shared/native-chat/transcript/native-chat-source-receipts'
import type { NativeChatMessage } from '../../../../../../../shared/native-chat/native-chat-types'
import { NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX } from '../../../../../../../shared/native-chat/native-chat-scope-cache'
import {
  NATIVE_CHAT_PENDING_SEND_LIMIT,
  type NativeChatPendingSend
} from '../../../../../../../shared/native-chat/transcript/native-chat-pending-sends'
import {
  assignNativeChatPendingOccurrence,
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
  sourceOwner?: string
  promptWatermarks?: ReadonlyMap<string, number>
  search?: {
    generation: IncrementalChatAssembler['generation']
    length: number
    found: boolean
  }
}
const pendingSendCache = new Map<string, PendingOwner>()
const EMPTY_PENDING_SENDS: NativeChatPendingSend[] = []
Object.freeze(EMPTY_PENDING_SENDS)
let pendingSendCounter = 0

function retainPendingOwner(key: string, owner: PendingOwner, promote = false): void {
  if (promote || !owner.pending.length) {
    pendingSendCache.delete(key)
  }
  pendingSendCache.set(key, owner)
  if (pendingSendCache.size <= NATIVE_CHAT_COMPOSER_SCOPE_CACHE_MAX) {
    return
  }
  // Reading history cannot displace a recoverable input, including the newly observed scope.
  const replaceable = [...pendingSendCache].find(([, value]) => !value.pending.length)?.[0]
  const oldest = replaceable ?? pendingSendCache.keys().next().value
  if (oldest !== undefined) {
    pendingSendCache.delete(oldest)
  }
}

function pendingSendScopeKey(scope: NativeChatPendingSendScope): string {
  return `${scope.paneKey}\0${scope.agent}`
}

export function readPendingSendCache(scope: NativeChatPendingSendScope): NativeChatPendingSend[] {
  return pendingSendCache.get(pendingSendScopeKey(scope))?.pending ?? EMPTY_PENDING_SENDS
}

export function writePendingSendCache(
  scope: NativeChatPendingSendScope,
  pending: NativeChatPendingSend[],
  promote = false
): NativeChatPendingSend[] {
  const next = releaseNativeChatReceiptDependencies(pending.slice(-NATIVE_CHAT_PENDING_SEND_LIMIT))
  const key = pendingSendScopeKey(scope)
  const owner = pendingSendCache.get(key)
  retainPendingOwner(key, { ...owner, pending: next }, promote)
  return next
}

/** Retain the last observed source frontier through empty drains and older paged snapshots. */
export function observePendingSendCache(
  scope: NativeChatPendingSendScope,
  messages: readonly NativeChatMessage[],
  sessionId: string,
  generation?: IncrementalChatAssembler['generation'],
  context?: NativeChatSourceContext
): void {
  const key = pendingSendScopeKey(scope)
  const owner = pendingSendCache.get(key) ?? { pending: [] }
  const sameOwner = owner.sessionId === sessionId && owner.sourceOwner === context?.owner
  const previous = sameOwner ? owner.boundary : undefined
  const last = messages.at(-1)
  const message = last?.source === 'transcript' ? last : undefined
  if (!message) {
    if (!sameOwner) {
      retainPendingOwner(key, {
        ...owner,
        sessionId,
        sourceOwner: context?.owner,
        boundary: undefined,
        search: undefined
      })
    }
    return
  }
  const position = nativeChatSourcePosition(message)
  if (
    previous?.id === message.id &&
    previous.position?.kind === position?.kind &&
    previous.position?.value === position?.value
  ) {
    if (
      generation &&
      (owner.search?.generation !== generation || owner.search.length !== messages.length)
    ) {
      retainPendingOwner(key, {
        ...owner,
        search: { generation, length: messages.length, found: true }
      })
    }
    return
  }
  let advances = !previous
  const search = sameOwner ? owner.search : undefined
  const extension =
    generation && search?.generation === generation && search.length <= messages.length
  if (previous) {
    if (position && previous.position?.kind === position.kind) {
      advances = position.value > previous.position.value
    } else {
      advances = extension ? search.found : false
      const start = extension ? search.length : 0
      for (let index = messages.length - 2; !advances && index >= start; index--) {
        if (messages[index].id === previous.id) {
          advances = true
          break
        }
      }
    }
  }
  if (generation || !sameOwner || advances) {
    retainPendingOwner(key, {
      ...owner,
      sessionId,
      sourceOwner: context?.owner,
      search: generation ? { generation, length: messages.length, found: advances } : undefined,
      boundary:
        message && advances
          ? {
              sessionId,
              id: message.id,
              timestamp: message.timestamp,
              position,
              owner: context?.owner
            }
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
  const legacyKey = nativeChatPendingContentKey(entry)
  // Why: a resend replaces its failed copy; kept, that copy would claim the resend's row and pin it.
  const existing = readPendingSendCache(scope).filter(
    (candidate) =>
      !candidate.delivery ||
      (requestKey(candidate) !== contentKey &&
        (candidate.sourceAgent ||
          entry.sourceAgent ||
          nativeChatPendingContentKey(candidate) !== legacyKey))
  )
  const owner = pendingSendCache.get(pendingSendScopeKey(scope))
  const boundary = owner?.boundary
  const captured =
    entry.sourceAgent &&
    boundary &&
    boundary.owner === entry.sourceContext?.owner &&
    (activeSessionId === undefined || boundary.sessionId === activeSessionId) &&
    (!entry.afterEmptyTranscriptSessionId ||
      entry.afterEmptyTranscriptSessionId === boundary.sessionId)
      ? {
          ...entry,
          sourceBoundary: boundary
        }
      : entry
  const assigned = assignNativeChatPendingOccurrence(
    existing
      .filter((value) => canClaimNativeChatReceipt(value, true))
      .map((value) => ({ ...value, sourceAgent: undefined })),
    { ...captured, sourceAgent: undefined }
  )
  const next = { ...assigned, sourceAgent: captured.sourceAgent }
  return writePendingSendCache(scope, [...existing, next], true)
}

/** A finite observation belongs to one original send, even if its row later settles through text matching. */
export function associatePendingPromptSubmissions(
  scope: NativeChatPendingSendScope,
  entries: NativeChatPendingSend[],
  history: readonly NativeChatPromptSubmission[]
): NativeChatPendingSend[] {
  const key = pendingSendScopeKey(scope)
  const owner = pendingSendCache.get(key)
  const watermarks = new Map(owner?.promptWatermarks)
  let next = entries
  for (const submission of [...history].sort(
    (a, b) => a.observation.revision - b.observation.revision
  )) {
    const compatible = next.flatMap((entry, index) => {
      const binding = entry.promptBinding
      const baseline = binding?.rootBaseline
      if (
        !entry.sourceAgent ||
        !binding ||
        !baseline ||
        entry.delivery === 'rejected' ||
        baseline.connectionId !== submission.connectionId ||
        !isSameAgentProcess(baseline.process, submission.process) ||
        baseline.observation.authorityId !== submission.observation.authorityId ||
        baseline.observation.incarnation !== submission.observation.incarnation ||
        baseline.observation.revision >= submission.observation.revision ||
        (baseline.sessionId && baseline.sessionId !== submission.sessionId) ||
        (entry.sourceSessionId && entry.sourceSessionId !== submission.sessionId)
      ) {
        return []
      }
      const lifetime = JSON.stringify([
        binding.runtimeId,
        binding.ptyId,
        binding.generation,
        binding.processIncarnation,
        baseline.process,
        baseline.observation.authorityId,
        baseline.observation.incarnation,
        baseline.connectionId
      ])
      return submission.observation.revision > (watermarks.get(lifetime) ?? -1)
        ? [{ entry, index, lifetime }]
        : []
    })
    const match = compatible.find(
      ({ entry }) =>
        !entry.promptSubmission &&
        nativeChatSourcePendingKeys(entry).includes(
          JSON.stringify([entry.sourceAgent, submission.textDigest, []])
        )
    )
    if (match) {
      next = next.map((entry, index) =>
        index === match.index ? { ...entry, promptSubmission: submission } : entry
      )
    }
    for (const { lifetime } of compatible) {
      watermarks.set(lifetime, submission.observation.revision)
    }
  }
  while (watermarks.size > NATIVE_CHAT_PENDING_SEND_LIMIT) {
    const oldest = watermarks.keys().next().value
    if (oldest === undefined) {
      break
    }
    watermarks.delete(oldest)
  }
  if (owner) {
    retainPendingOwner(key, { ...owner, promptWatermarks: watermarks })
  }
  return next
}

export function clearPendingSendCacheForTests(): void {
  pendingSendCache.clear()
  pendingSendCounter = 0
}

export function nextNativeChatPendingSendId(now = Date.now()): string {
  pendingSendCounter += 1
  return `${now}-${pendingSendCounter}`
}
