import {
  isSafeJcodeSessionId,
  readJcodeSessionMetadata,
  type JcodeSessionMetadata
} from '../jcode-session-files'
import {
  bindRoot,
  bindWorker,
  copyRegistry,
  retireSession,
  sessionKey,
  type JcodeSessionBinding,
  type JcodeSessionRegistry
} from './jcode-session-ownership'
import {
  bufferJcodePendingInput,
  moveJcodePendingInputs,
  findJcodePendingInput,
  trimJcodePendingInputs,
  JCODE_PENDING_TTL_MS,
  type JcodeSessionInput
} from './jcode-pending-input-queue'
import type { HookListenerState } from './listener-state'

export {
  clearJcodePaneSessions,
  jcodePaneHasStateClaims,
  createJcodeSessionRegistry,
  bindJcodeRootSession,
  bindJcodeWorkerSession,
  lookupJcodeSessionBinding,
  type JcodeSessionBinding,
  type JcodeSessionRegistry
} from './jcode-session-ownership'
export type { JcodeSessionInput } from './jcode-pending-input-queue'

const proposedChanges = Symbol('JcodeSessionChanges')

export type JcodeSessionChanges = {
  readonly [proposedChanges]: { before: JcodeSessionRegistry; after: JcodeSessionRegistry }
}

export type JcodeSessionResolution = (
  | { kind: 'root'; binding: JcodeSessionBinding; metadata?: JcodeSessionMetadata }
  | { kind: 'worker'; binding: JcodeSessionBinding; metadata?: JcodeSessionMetadata }
  | { kind: 'pending' | 'ignored' }
) & { changes: JcodeSessionChanges }

export function resolveJcodeSessionEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: string,
  hookPayload: Record<string, unknown>,
  now: number = Date.now(),
  input?: JcodeSessionInput
): JcodeSessionResolution {
  const before = state.jcodeSessions
  const rawId = hookPayload.session_id
  if (!isSafeJcodeSessionId(rawId)) {
    return { kind: 'ignored', changes: { [proposedChanges]: { before, after: before } } }
  }
  const sessionId = rawId.trim()
  const next = copyRegistry(before)
  const changes = { [proposedChanges]: { before, after: next } }
  next.pending = trimJcodePendingInputs(next.pending, now)
  const queuedIndex = findJcodePendingInput(next.pending, input)
  const finish = (result: { kind: 'pending' | 'ignored' }): JcodeSessionResolution => {
    return { ...result, changes }
  }
  const key = sessionKey(paneKey, sessionId)
  for (const [resumeKey, receivedAt] of next.resumes) {
    if (!next.tombstones.has(resumeKey) || now - receivedAt >= JCODE_PENDING_TTL_MS) {
      next.resumes.delete(resumeKey)
    }
  }
  const resumeStart = eventName === 'session_start' && hookPayload.source === 'resume'
  const rootStart =
    resumeStart || (eventName === 'session_start' && hookPayload.source === 'create')
  // Resume hooks precede persistence, so retain Closed evidence until a later hook reads Active.
  const rememberResume = (metadata?: JcodeSessionMetadata): void => {
    if (resumeStart && metadata?.closed && metadata.parentId === null && next.tombstones.has(key)) {
      next.resumes.set(key, now)
    }
  }
  if (next.tombstones.has(key) && eventName === 'session_end') {
    next.resumes.delete(key)
    return finish({ kind: 'ignored' })
  }
  if (next.tombstones.has(key) && !rootStart && !next.resumes.has(key)) {
    return finish({ kind: 'ignored' })
  }
  let binding = next.bindings.get(key)
  if (!binding && next.overflowPanes.has(paneKey)) {
    return finish({ kind: 'ignored' })
  }
  const cachedMetadata = readJcodeSessionMetadata(sessionId, next.metadataCache, now)
  const metadata = cachedMetadata ? { ...cachedMetadata } : undefined
  if (next.tombstones.has(key)) {
    if (!metadata || metadata.closed || metadata.parentId !== null) {
      rememberResume(metadata)
      return finish({ kind: 'ignored' })
    }
    next.tombstones.delete(key)
    next.resumes.delete(key)
    if (!bindRoot(next, paneKey, sessionId, 'session-file')) {
      return { kind: 'ignored', changes: { [proposedChanges]: { before, after: before } } }
    }
    binding = next.bindings.get(key)
  }
  if (
    metadata?.closed &&
    !(binding?.role === 'root' && binding.basis === 'launch') &&
    (!binding || eventName !== 'session_end')
  ) {
    if (binding) {
      retireSession(next, paneKey, sessionId)
      rememberResume(metadata)
    }
    return finish({ kind: 'ignored' })
  }
  const activeRoot = next.roots.get(paneKey)
  if (
    binding?.role === 'worker' &&
    metadata?.parentId &&
    metadata.parentId !== binding.rootSessionId
  ) {
    return finish({ kind: 'ignored' })
  }
  if (!binding && metadata && !metadata.closed) {
    if (metadata.parentId === null) {
      if (activeRoot || !bindRoot(next, paneKey, sessionId, 'session-file')) {
        return finish({ kind: 'ignored' })
      }
    } else if (activeRoot) {
      if (
        metadata.parentId !== activeRoot ||
        !bindWorker(next, paneKey, activeRoot, sessionId, 'session-file')
      ) {
        return finish({ kind: 'ignored' })
      }
    }
    binding = next.bindings.get(key)
  }
  if (binding) {
    if (queuedIndex >= 0) {
      next.pending.splice(queuedIndex, 1)
    }
    if (eventName === 'session_end') {
      retireSession(next, paneKey, sessionId)
    }
    return binding.role === 'root'
      ? { kind: 'root', binding: { ...binding }, metadata, changes }
      : { kind: 'worker', binding: { ...binding }, metadata, changes }
  }
  if (eventName === 'session_end') {
    retireSession(next, paneKey, sessionId)
    return finish({ kind: 'ignored' })
  }
  if (input && queuedIndex < 0) {
    next.pending = bufferJcodePendingInput(
      next.pending,
      {
        paneKey,
        sessionId,
        rootSessionId: metadata?.parentId ?? undefined,
        eventName,
        hookPayload,
        input
      },
      now
    )
  }
  return finish({ kind: 'pending' })
}

export function commitJcodeSessionResolution(
  state: HookListenerState,
  resolution: JcodeSessionResolution
): void {
  const { before, after } = resolution.changes[proposedChanges]
  if (state.jcodeSessions === before) {
    state.jcodeSessions = after
  }
}

export function takeResolvedJcodeEvents(
  state: HookListenerState,
  paneKey: string,
  now: number = Date.now()
): JcodeSessionInput[] {
  return state.jcodeSessions.pending
    .filter((event) => {
      if (event.paneKey !== paneKey || now - event.input.receivedAt >= JCODE_PENDING_TTL_MS) {
        return false
      }
      const resolution = resolveJcodeSessionEvent(
        state,
        paneKey,
        event.eventName,
        event.hookPayload,
        now
      )
      return resolution.kind === 'root' || resolution.kind === 'worker'
    })
    .map((event) => event.input)
}

export function closeJcodeSession(
  state: HookListenerState,
  paneKey: string,
  sessionId: string
): void {
  if (!isSafeJcodeSessionId(sessionId)) {
    return
  }
  const id = sessionId.trim()
  const registry = state.jcodeSessions
  if (
    !registry.bindings.has(sessionKey(paneKey, id)) &&
    !registry.resumes.has(sessionKey(paneKey, id)) &&
    !registry.pending.some(
      (event) => event.paneKey === paneKey && (event.sessionId === id || event.rootSessionId === id)
    ) &&
    (registry.tombstones.has(sessionKey(paneKey, id)) || registry.overflowPanes.has(paneKey))
  ) {
    return
  }
  const next = copyRegistry(registry)
  retireSession(next, paneKey, id)
  state.jcodeSessions = next
}

export function moveJcodePaneSessions(
  state: HookListenerState,
  fromPaneKey: string,
  toPaneKey: string
): boolean {
  if (fromPaneKey === toPaneKey) {
    return true
  }
  const registry = state.jcodeSessions
  if (registry.roots.has(toPaneKey)) {
    return false
  }
  if (
    !registry.roots.has(fromPaneKey) &&
    !Array.from(registry.bindings.values()).some((binding) => binding.paneKey === fromPaneKey) &&
    !registry.pending.some((event) => event.paneKey === fromPaneKey) &&
    !Array.from(registry.tombstones.values()).includes(fromPaneKey) &&
    !registry.overflowPanes.has(fromPaneKey)
  ) {
    return true
  }
  const next = copyRegistry(registry)
  const root = next.roots.get(fromPaneKey)
  if (root) {
    next.roots.delete(fromPaneKey)
    next.roots.set(toPaneKey, root)
  }
  for (const [key, binding] of next.bindings) {
    if (binding.paneKey === fromPaneKey) {
      next.bindings.delete(key)
      next.bindings.set(sessionKey(toPaneKey, binding.sessionId), {
        ...binding,
        paneKey: toPaneKey
      })
    }
  }
  for (const [key, owner] of next.tombstones) {
    if (owner === fromPaneKey) {
      next.tombstones.delete(key)
      next.tombstones.set(`${toPaneKey}${key.slice(fromPaneKey.length)}`, toPaneKey)
    }
  }
  if (next.overflowPanes.delete(fromPaneKey)) {
    next.overflowPanes.add(toPaneKey)
  }
  for (const [key, receivedAt] of next.resumes) {
    if (key.startsWith(`${fromPaneKey}\0`)) {
      next.resumes.delete(key)
      next.resumes.set(`${toPaneKey}${key.slice(fromPaneKey.length)}`, receivedAt)
    }
  }
  next.pending = moveJcodePendingInputs(next.pending, fromPaneKey, toPaneKey)
  state.jcodeSessions = next
  return true
}
