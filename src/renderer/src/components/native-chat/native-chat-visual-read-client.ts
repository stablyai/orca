// Revalidate every mount against the owner host; cache revisions to spare bytes, never failures.

import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  AGENT_SESSION_VISUAL_READ_ERRORS,
  type AgentSessionReadVisualResult,
  type AgentSessionVisualReadError
} from '../../../../shared/rpc-contract/agent-session-visual-params'

export type NativeChatVisualIdentity = {
  target: RuntimeClientTarget
  sessionId: string
  file: string
}

/** `path`: the visual's absolute path on the chat's host, which opens it like any file there. */
export type NativeChatVisualDocument = { revision: string; html: string; path: string }

/** `unavailable`: the host could not answer (contact lost, older host); never a verdict on the file. */
export type NativeChatVisualReadOutcome =
  | { ok: true; document: NativeChatVisualDocument }
  | { ok: false; reason: AgentSessionVisualReadError | 'unavailable' }

const MAX_CACHED_DOCUMENTS = 24
const MAX_CACHED_CHARS = 6 * 1024 * 1024
const READ_TIMEOUT_MS = 15_000

const cache = new Map<string, NativeChatVisualDocument>()
const inFlight = new Map<string, Promise<NativeChatVisualReadOutcome>>()

export function nativeChatVisualKey(identity: NativeChatVisualIdentity): string {
  const runtime =
    identity.target.kind === 'local' ? 'local' : `environment:${identity.target.environmentId}`
  return JSON.stringify([runtime, identity.sessionId, identity.file])
}

export function peekCachedNativeChatVisual(
  identity: NativeChatVisualIdentity
): NativeChatVisualDocument | null {
  return cache.get(nativeChatVisualKey(identity)) ?? null
}

function remember(key: string, document: NativeChatVisualDocument): void {
  cache.delete(key)
  cache.set(key, document)
  let chars = 0
  for (const entry of cache.values()) {
    chars += entry.html.length
  }
  for (const [oldestKey, oldest] of cache) {
    if (cache.size <= MAX_CACHED_DOCUMENTS && chars <= MAX_CACHED_CHARS) {
      break
    }
    cache.delete(oldestKey)
    chars -= oldest.html.length
  }
}

function isKnownReadError(value: unknown): value is AgentSessionVisualReadError {
  return AGENT_SESSION_VISUAL_READ_ERRORS.some((known) => known === value)
}

function interpret(
  key: string,
  result: AgentSessionReadVisualResult | null | undefined
): NativeChatVisualReadOutcome {
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'unavailable' }
  }
  if (result.ok) {
    if ('unchanged' in result) {
      const cached = cache.get(key)
      if (cached?.revision === result.revision) {
        remember(key, cached)
        return { ok: true, document: cached }
      }
      return { ok: false, reason: 'unavailable' }
    }
    if (
      typeof result.html !== 'string' ||
      typeof result.revision !== 'string' ||
      typeof result.path !== 'string'
    ) {
      return { ok: false, reason: 'unavailable' }
    }
    const document = { revision: result.revision, html: result.html, path: result.path }
    remember(key, document)
    return { ok: true, document }
  }
  // Any refusal means the cached revision no longer stands for the file.
  cache.delete(key)
  // Why: a newer host may name a refusal this build does not know; it still reads as "can't show".
  return { ok: false, reason: isKnownReadError(result.error) ? result.error : 'unavailable' }
}

async function readOnce(
  key: string,
  identity: NativeChatVisualIdentity
): Promise<NativeChatVisualReadOutcome> {
  const known = cache.get(key)?.revision
  try {
    const result = await callRuntimeRpc<AgentSessionReadVisualResult>(
      identity.target,
      'agentSession.readVisual',
      {
        sessionId: identity.sessionId,
        file: identity.file,
        ...(known ? { knownRevision: known } : {})
      },
      { timeoutMs: READ_TIMEOUT_MS }
    )
    const outcome = interpret(key, result)
    // An `unchanged` answer for an entry evicted meanwhile: ask once more for the bytes.
    if (!outcome.ok && outcome.reason === 'unavailable' && result?.ok && 'unchanged' in result) {
      cache.delete(key)
      return interpret(
        key,
        await callRuntimeRpc<AgentSessionReadVisualResult>(
          identity.target,
          'agentSession.readVisual',
          { sessionId: identity.sessionId, file: identity.file },
          { timeoutMs: READ_TIMEOUT_MS }
        )
      )
    }
    return outcome
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

/** Share concurrent reads; fresh waits for any in-flight read then refetches so post-save reads cannot return pre-save bytes. */
export function readNativeChatVisual(
  identity: NativeChatVisualIdentity,
  options?: { fresh?: boolean }
): Promise<NativeChatVisualReadOutcome> {
  const key = nativeChatVisualKey(identity)
  const pending = inFlight.get(key)
  if (pending && !options?.fresh) {
    return pending
  }
  const start = (): Promise<NativeChatVisualReadOutcome> => readOnce(key, identity)
  const read = (pending ? pending.then(start) : start()).finally(() => {
    if (inFlight.get(key) === read) {
      inFlight.delete(key)
    }
  })
  inFlight.set(key, read)
  return read
}

/** Whether a failed read may succeed if asked again shortly: contact restored, or the file landing. */
export function isRetryableNativeChatVisualFailure(
  reason: AgentSessionVisualReadError | 'unavailable'
): boolean {
  return reason === 'unavailable' || reason === 'not_found'
}

export function clearNativeChatVisualCacheForTests(): void {
  cache.clear()
  inFlight.clear()
}
