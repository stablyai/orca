import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { isTerminalLeafId } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'

type MirrorPaneAuthority = {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  publicationEpoch: string
  snapshotVersion: number
}

const authorityByPaneKey = new Map<string, MirrorPaneAuthority>()
const paneKeysBySessionKey = new Map<string, Set<string>>()
const authorityRevisionBySessionKey = new Map<string, number>()
const authorityListenersBySessionKey = new Map<string, Set<() => void>>()
let nextAuthorityRevision = 1

function sessionKey(environmentId: string, worktreeId: string): string {
  return JSON.stringify([environmentId, worktreeId])
}

function paneKey(
  authority: Pick<MirrorPaneAuthority, 'environmentId' | 'worktreeId' | 'tabId' | 'leafId'>
): string {
  return JSON.stringify([
    authority.environmentId,
    authority.worktreeId,
    authority.tabId,
    authority.leafId
  ])
}

function authoritySignature(paneKeys: ReadonlySet<string> | undefined): string {
  const authorityEntries = Array.from(paneKeys ?? [], (key) => {
    const authority = authorityByPaneKey.get(key)
    return [key, authority?.ptyId ?? null] as const
  })
  authorityEntries.sort(([left], [right]) => left.localeCompare(right))
  return JSON.stringify(authorityEntries)
}

function deleteSessionAuthority(session: string): boolean {
  const paneKeys = paneKeysBySessionKey.get(session)
  for (const key of paneKeys ?? []) {
    authorityByPaneKey.delete(key)
  }
  paneKeysBySessionKey.delete(session)
  return Boolean(paneKeys?.size)
}

function parseSessionKey(session: string): [string, string] {
  return JSON.parse(session) as [string, string]
}

function publishSessionAuthorityChange(
  environmentId: string,
  worktreeId: string,
  hasAuthority: boolean
): void {
  const session = sessionKey(environmentId, worktreeId)
  const listeners = authorityListenersBySessionKey.get(session)
  if (hasAuthority && listeners?.size) {
    authorityRevisionBySessionKey.set(session, nextAuthorityRevision++)
  } else {
    authorityRevisionBySessionKey.delete(session)
  }
  for (const listener of listeners ?? []) {
    listener()
  }
}

export function replaceWebSessionTerminalParkAuthority(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): void {
  const session = sessionKey(environmentId, snapshot.worktree)
  const priorSignature = authoritySignature(paneKeysBySessionKey.get(session))
  deleteSessionAuthority(session)
  const paneKeys = new Set<string>()
  for (const surface of snapshot.tabs) {
    if (
      surface.type !== 'terminal' ||
      surface.status !== 'ready' ||
      !isTerminalLeafId(surface.leafId)
    ) {
      continue
    }
    const authority: MirrorPaneAuthority = {
      environmentId,
      worktreeId: snapshot.worktree,
      tabId: toWebTerminalSurfaceTabId(surface.parentTabId),
      leafId: surface.leafId,
      ptyId: toRemoteRuntimePtyId(surface.terminal, environmentId),
      publicationEpoch: snapshot.publicationEpoch,
      snapshotVersion: snapshot.snapshotVersion
    }
    const key = paneKey(authority)
    authorityByPaneKey.set(key, authority)
    paneKeys.add(key)
  }
  if (paneKeys.size > 0) {
    paneKeysBySessionKey.set(session, paneKeys)
  }
  if (authoritySignature(paneKeys) !== priorSignature) {
    publishSessionAuthorityChange(environmentId, snapshot.worktree, paneKeys.size > 0)
  }
}

export function hasWebSessionTerminalParkAuthority(args: {
  environmentId: string
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
}): boolean {
  const authority = authorityByPaneKey.get(paneKey(args))
  return (
    authority?.environmentId === args.environmentId &&
    authority.worktreeId === args.worktreeId &&
    authority.tabId === args.tabId &&
    authority.leafId === args.leafId &&
    authority.ptyId === args.ptyId
  )
}

export function clearWebSessionTerminalParkAuthorityForWorktree(
  environmentId: string,
  worktreeId: string
): void {
  const session = sessionKey(environmentId, worktreeId)
  const hadAuthority = deleteSessionAuthority(session)
  const hadRevision = authorityRevisionBySessionKey.delete(session)
  if (hadAuthority || hadRevision) {
    publishSessionAuthorityChange(environmentId, worktreeId, false)
  }
}

export function clearWebSessionTerminalParkAuthorityForEnvironment(environmentId: string): void {
  const sessions = new Set([
    ...paneKeysBySessionKey.keys(),
    ...authorityRevisionBySessionKey.keys()
  ])
  for (const session of sessions) {
    const parsed = parseSessionKey(session)
    if (parsed[0] !== environmentId) {
      continue
    }
    const hadAuthority = deleteSessionAuthority(session)
    const hadRevision = authorityRevisionBySessionKey.delete(session)
    if (hadAuthority || hadRevision) {
      publishSessionAuthorityChange(parsed[0], parsed[1], false)
    }
  }
}

export function getWebSessionTerminalParkAuthorityRevisionKey(
  worktreeId: string,
  environmentIds: readonly string[]
): string {
  return environmentIds
    .map(
      (environmentId) =>
        `${environmentId}:${authorityRevisionBySessionKey.get(sessionKey(environmentId, worktreeId)) ?? 0}`
    )
    .join('|')
}

type AuthorityRevisionScope = readonly (readonly [worktreeId: string, environmentIds: string[]])[]

export function createWebSessionTerminalParkAuthorityRevisionScopeKey(
  scope: AuthorityRevisionScope
): string {
  return JSON.stringify(scope.filter(([, environmentIds]) => environmentIds.length > 0))
}

function parseAuthorityRevisionScopeKey(scopeKey: string): AuthorityRevisionScope {
  return scopeKey ? (JSON.parse(scopeKey) as AuthorityRevisionScope) : []
}

function seedAuthorityRevisions(scope: AuthorityRevisionScope): void {
  for (const [worktreeId, environmentIds] of scope) {
    for (const environmentId of environmentIds) {
      const session = sessionKey(environmentId, worktreeId)
      if (paneKeysBySessionKey.has(session) && !authorityRevisionBySessionKey.has(session)) {
        authorityRevisionBySessionKey.set(session, nextAuthorityRevision++)
      }
    }
  }
}

function getAuthorityRevisionScopeSnapshot(scope: AuthorityRevisionScope): string {
  return JSON.stringify(
    scope.flatMap(([worktreeId, environmentIds]) =>
      environmentIds.map((environmentId) => [
        worktreeId,
        environmentId,
        authorityRevisionBySessionKey.get(sessionKey(environmentId, worktreeId)) ?? 0
      ])
    )
  )
}

export function useWebSessionTerminalParkAuthorityRevisionScopeKey(scopeKey: string): string {
  const scope = useMemo(() => parseAuthorityRevisionScopeKey(scopeKey), [scopeKey])
  const subscribe = useCallback(
    (listener: () => void) => {
      if (scope.length === 0) {
        return () => undefined
      }
      const sessions = new Set(
        scope.flatMap(([worktreeId, environmentIds]) =>
          environmentIds.map((environmentId) => sessionKey(environmentId, worktreeId))
        )
      )
      for (const session of sessions) {
        const listeners = authorityListenersBySessionKey.get(session) ?? new Set<() => void>()
        listeners.add(listener)
        authorityListenersBySessionKey.set(session, listeners)
      }
      seedAuthorityRevisions(scope)
      return () => {
        for (const session of sessions) {
          const listeners = authorityListenersBySessionKey.get(session)
          listeners?.delete(listener)
          if (listeners?.size === 0) {
            authorityListenersBySessionKey.delete(session)
            authorityRevisionBySessionKey.delete(session)
          }
        }
      }
    },
    [scope]
  )
  const getSnapshot = useCallback(() => getAuthorityRevisionScopeSnapshot(scope), [scope])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function useWebSessionTerminalParkAuthorityRevisionKey(
  worktreeId: string,
  environmentIdsKey: string
): string {
  const scopeKey = useMemo(
    () =>
      createWebSessionTerminalParkAuthorityRevisionScopeKey([
        [worktreeId, environmentIdsKey ? environmentIdsKey.split('\u0000') : []]
      ]),
    [environmentIdsKey, worktreeId]
  )
  return useWebSessionTerminalParkAuthorityRevisionScopeKey(scopeKey)
}

export function resetWebSessionTerminalParkAuthorityForTests(): void {
  authorityByPaneKey.clear()
  paneKeysBySessionKey.clear()
  authorityRevisionBySessionKey.clear()
  nextAuthorityRevision = 1
  for (const listeners of authorityListenersBySessionKey.values()) {
    for (const listener of listeners) {
      listener()
    }
  }
}

export function getWebSessionTerminalParkAuthorityCountForTests(): number {
  return authorityByPaneKey.size
}

export function getWebSessionTerminalParkAuthorityTrackingCountsForTests(): {
  authorities: number
  sessions: number
  revisions: number
  listeners: number
  listenerWorktrees: number
} {
  let listeners = 0
  const listenerWorktreeIds = new Set<string>()
  for (const [session, sessionListeners] of authorityListenersBySessionKey) {
    listeners += sessionListeners.size
    listenerWorktreeIds.add(parseSessionKey(session)[1])
  }
  return {
    authorities: authorityByPaneKey.size,
    sessions: paneKeysBySessionKey.size,
    revisions: authorityRevisionBySessionKey.size,
    listeners,
    listenerWorktrees: listenerWorktreeIds.size
  }
}
