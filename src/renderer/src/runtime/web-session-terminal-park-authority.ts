import { useCallback, useSyncExternalStore } from 'react'
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
const authorityListenersByWorktreeId = new Map<string, Set<() => void>>()
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

function publishSessionAuthorityRevision(environmentId: string, worktreeId: string): void {
  authorityRevisionBySessionKey.set(sessionKey(environmentId, worktreeId), nextAuthorityRevision++)
  for (const listener of authorityListenersByWorktreeId.get(worktreeId) ?? []) {
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
    publishSessionAuthorityRevision(environmentId, snapshot.worktree)
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
  if (deleteSessionAuthority(session)) {
    publishSessionAuthorityRevision(environmentId, worktreeId)
  }
}

export function clearWebSessionTerminalParkAuthorityForEnvironment(environmentId: string): void {
  for (const session of Array.from(paneKeysBySessionKey.keys())) {
    const parsed = JSON.parse(session) as [string, string]
    if (parsed[0] !== environmentId) {
      continue
    }
    if (deleteSessionAuthority(session)) {
      publishSessionAuthorityRevision(parsed[0], parsed[1])
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

export function useWebSessionTerminalParkAuthorityRevisionKey(
  worktreeId: string,
  environmentIdsKey: string
): string {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!environmentIdsKey) {
        return () => undefined
      }
      const listeners = authorityListenersByWorktreeId.get(worktreeId) ?? new Set<() => void>()
      listeners.add(listener)
      authorityListenersByWorktreeId.set(worktreeId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          authorityListenersByWorktreeId.delete(worktreeId)
        }
      }
    },
    [environmentIdsKey, worktreeId]
  )
  const getSnapshot = useCallback(() => {
    const environmentIds = environmentIdsKey ? environmentIdsKey.split('\u0000') : []
    return getWebSessionTerminalParkAuthorityRevisionKey(worktreeId, environmentIds)
  }, [environmentIdsKey, worktreeId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function resetWebSessionTerminalParkAuthorityForTests(): void {
  authorityByPaneKey.clear()
  paneKeysBySessionKey.clear()
  authorityRevisionBySessionKey.clear()
  nextAuthorityRevision = 1
  for (const listeners of authorityListenersByWorktreeId.values()) {
    for (const listener of listeners) {
      listener()
    }
  }
}

export function getWebSessionTerminalParkAuthorityCountForTests(): number {
  return authorityByPaneKey.size
}
