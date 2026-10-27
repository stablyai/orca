import {
  createJcodeSessionMetadataCache,
  isSafeJcodeSessionId,
  readJcodeSessionMetadata,
  type JcodeSessionMetadataCache
} from '../jcode-session-files'
import { forgetCachedJcodeSessions } from '../jcode-session-metadata-cache'
import type { PendingEvent } from './jcode-pending-input-queue'
import type { HookListenerState } from './listener-state'

const BINDINGS_MAX = 1_000
const TOMBSTONES_MAX = 1_000

export type JcodeSessionBinding = {
  paneKey: string
  rootSessionId: string
  sessionId: string
  role: 'root' | 'worker'
  basis: 'launch' | 'session-file' | 'spawn-hook'
}

export type JcodeSessionRegistry = {
  metadataCache: JcodeSessionMetadataCache
  roots: Map<string, string>
  bindings: Map<string, JcodeSessionBinding>
  pending: PendingEvent[]
  tombstones: Map<string, string>
  // Tombstoned resumes wait for Active metadata; TOMBSTONES_MAX also bounds this evidence.
  resumes: Map<string, number>
  overflowPanes: Set<string>
}

export function createJcodeSessionRegistry(): JcodeSessionRegistry {
  return {
    metadataCache: createJcodeSessionMetadataCache(),
    roots: new Map(),
    bindings: new Map(),
    pending: [],
    tombstones: new Map(),
    resumes: new Map(),
    overflowPanes: new Set()
  }
}

export function copyRegistry(source: JcodeSessionRegistry): JcodeSessionRegistry {
  return {
    metadataCache: createJcodeSessionMetadataCache(source.metadataCache),
    roots: new Map(source.roots),
    bindings: new Map(source.bindings),
    pending: [...source.pending],
    tombstones: new Map(source.tombstones),
    resumes: new Map(source.resumes),
    overflowPanes: new Set(source.overflowPanes)
  }
}

export function sessionKey(paneKey: string, sessionId: string): string {
  return `${paneKey}\0${sessionId}`
}

function tombstone(registry: JcodeSessionRegistry, paneKey: string, sessionId: string): void {
  const key = sessionKey(paneKey, sessionId)
  if (registry.tombstones.has(key)) {
    return
  }
  if (registry.tombstones.size >= TOMBSTONES_MAX) {
    // Lost close evidence fences unknown sessions for this pane lifecycle.
    registry.overflowPanes.add(paneKey)
    return
  }
  registry.tombstones.set(key, paneKey)
}

export function retireSession(
  registry: JcodeSessionRegistry,
  paneKey: string,
  sessionId: string
): void {
  const retired = new Set([sessionId])
  if (registry.roots.get(paneKey) === sessionId) {
    registry.roots.delete(paneKey)
  }
  for (const binding of registry.bindings.values()) {
    if (binding.paneKey === paneKey && binding.rootSessionId === sessionId) {
      retired.add(binding.sessionId)
    }
  }
  for (const event of registry.pending) {
    if (event.paneKey === paneKey && event.rootSessionId === sessionId) {
      retired.add(event.sessionId)
    }
  }
  for (const id of retired) {
    registry.bindings.delete(sessionKey(paneKey, id))
    registry.resumes.delete(sessionKey(paneKey, id))
    tombstone(registry, paneKey, id)
  }
  registry.pending = registry.pending.filter(
    (event) => event.paneKey !== paneKey || !retired.has(event.sessionId)
  )
  forgetCachedJcodeSessions(registry.metadataCache, retired)
}

export function bindRoot(
  registry: JcodeSessionRegistry,
  paneKey: string,
  sessionId: string,
  basis: 'launch' | 'session-file'
): boolean {
  const key = sessionKey(paneKey, sessionId)
  const existing = registry.bindings.get(key)
  const activeRoot = registry.roots.get(paneKey)
  if (existing?.role === 'worker') {
    return false
  }
  if (activeRoot && activeRoot !== sessionId) {
    if (basis !== 'launch') {
      return false
    }
    retireSession(registry, paneKey, activeRoot)
  }
  if (!existing && registry.bindings.size >= BINDINGS_MAX) {
    return false
  }
  if (basis !== 'launch' && (registry.tombstones.has(key) || registry.overflowPanes.has(paneKey))) {
    return false
  }
  registry.tombstones.delete(key)
  registry.resumes.delete(key)
  registry.roots.set(paneKey, sessionId)
  registry.bindings.set(key, {
    paneKey,
    rootSessionId: sessionId,
    sessionId,
    role: 'root',
    basis: existing?.basis === 'launch' ? 'launch' : basis
  })
  return true
}

export function bindWorker(
  registry: JcodeSessionRegistry,
  paneKey: string,
  rootSessionId: string,
  sessionId: string,
  basis: 'session-file' | 'spawn-hook'
): boolean {
  const key = sessionKey(paneKey, sessionId)
  const existing = registry.bindings.get(key)
  if (sessionId === rootSessionId || registry.roots.get(paneKey) !== rootSessionId) {
    return false
  }
  if (registry.tombstones.has(key) || (!existing && registry.overflowPanes.has(paneKey))) {
    return false
  }
  if (existing && (existing.role !== 'worker' || existing.rootSessionId !== rootSessionId)) {
    return false
  }
  if (!existing && registry.bindings.size >= BINDINGS_MAX) {
    return false
  }
  registry.bindings.set(key, {
    paneKey,
    rootSessionId,
    sessionId,
    role: 'worker',
    basis: existing?.basis === 'spawn-hook' ? 'spawn-hook' : basis
  })
  return true
}

export function bindJcodeRootSession(
  state: HookListenerState,
  paneKey: string,
  sessionId: string,
  basis: 'launch' | 'session-file'
): boolean {
  if (!isSafeJcodeSessionId(sessionId)) {
    return false
  }
  const id = sessionId.trim()
  const next = copyRegistry(state.jcodeSessions)
  if (basis === 'session-file') {
    const metadata = readJcodeSessionMetadata(id, next.metadataCache)
    if (!metadata || metadata.closed || metadata.parentId !== null) {
      return false
    }
  }
  if (!bindRoot(next, paneKey, id, basis)) {
    return false
  }
  state.jcodeSessions = next
  return true
}

export function bindJcodeWorkerSession(
  state: HookListenerState,
  paneKey: string,
  rootSessionId: string,
  sessionId: string,
  basis: 'session-file' | 'spawn-hook'
): boolean {
  if (!isSafeJcodeSessionId(sessionId) || !isSafeJcodeSessionId(rootSessionId)) {
    return false
  }
  const id = sessionId.trim()
  const root = rootSessionId.trim()
  const next = copyRegistry(state.jcodeSessions)
  const metadata = readJcodeSessionMetadata(id, next.metadataCache)
  if (metadata?.closed || (metadata?.parentId && metadata.parentId !== root)) {
    return false
  }
  if (basis === 'session-file' && metadata?.parentId !== root) {
    return false
  }
  if (!bindWorker(next, paneKey, root, id, basis)) {
    return false
  }
  state.jcodeSessions = next
  return true
}

export function lookupJcodeSessionBinding(
  state: HookListenerState,
  paneKey: string,
  sessionId: string
): JcodeSessionBinding | undefined {
  if (!isSafeJcodeSessionId(sessionId)) {
    return undefined
  }
  const binding = state.jcodeSessions.bindings.get(sessionKey(paneKey, sessionId.trim()))
  return binding ? { ...binding } : undefined
}

export function clearJcodePaneSessions(state: HookListenerState, paneKey: string): void {
  const registry = state.jcodeSessions
  const matches = (key: string): boolean => key === paneKey || key.startsWith(`${paneKey}\0`)
  const sessionIds = new Set<string>()
  for (const [key, id] of registry.roots) {
    if (matches(key)) {
      sessionIds.add(id)
    }
  }
  for (const binding of registry.bindings.values()) {
    if (matches(binding.paneKey)) {
      sessionIds.add(binding.sessionId)
    }
  }
  for (const event of registry.pending) {
    if (matches(event.paneKey)) {
      sessionIds.add(event.sessionId)
    }
  }
  for (const [key, owner] of registry.tombstones) {
    if (matches(owner)) {
      sessionIds.add(key.slice(owner.length + 1))
    }
  }
  const overflowPanes = Array.from(registry.overflowPanes).filter(matches)
  if (sessionIds.size === 0 && overflowPanes.length === 0) {
    return
  }
  const next = copyRegistry(registry)
  for (const key of next.roots.keys()) {
    if (matches(key)) {
      next.roots.delete(key)
    }
  }
  for (const [key, binding] of next.bindings) {
    if (matches(binding.paneKey)) {
      next.bindings.delete(key)
    }
  }
  for (const [key, owner] of next.tombstones) {
    if (matches(owner)) {
      next.tombstones.delete(key)
      next.resumes.delete(key)
    }
  }
  for (const key of overflowPanes) {
    next.overflowPanes.delete(key)
  }
  next.pending = next.pending.filter((event) => !matches(event.paneKey))
  forgetCachedJcodeSessions(next.metadataCache, sessionIds)
  state.jcodeSessions = next
}

export function jcodePaneHasStateClaims(state: HookListenerState, paneKey: string): boolean {
  return (
    state.jcodeTurnByPaneKey.get(paneKey)?.active === true ||
    state.jcodeRootPayloadByPaneKey.has(paneKey) ||
    state.jcodeSubagentRosterByPaneKey.has(paneKey) ||
    state.jcodeSessions.roots.has(paneKey) ||
    Array.from(state.jcodeSessions.bindings.values()).some(
      (binding) => binding.paneKey === paneKey
    ) ||
    Array.from(state.jcodeSessions.tombstones.values()).includes(paneKey) ||
    state.jcodeSessions.overflowPanes.has(paneKey) ||
    state.jcodeSessions.pending.some((event) => event.paneKey === paneKey)
  )
}
