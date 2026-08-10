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

export function replaceWebSessionTerminalParkAuthority(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string
): void {
  clearWebSessionTerminalParkAuthorityForWorktree(environmentId, snapshot.worktree)
  const session = sessionKey(environmentId, snapshot.worktree)
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
  for (const key of paneKeysBySessionKey.get(session) ?? []) {
    authorityByPaneKey.delete(key)
  }
  paneKeysBySessionKey.delete(session)
}

export function clearWebSessionTerminalParkAuthorityForEnvironment(environmentId: string): void {
  for (const [session, paneKeys] of paneKeysBySessionKey) {
    const parsed = JSON.parse(session) as [string, string]
    if (parsed[0] !== environmentId) {
      continue
    }
    for (const key of paneKeys) {
      authorityByPaneKey.delete(key)
    }
    paneKeysBySessionKey.delete(session)
  }
}

export function resetWebSessionTerminalParkAuthorityForTests(): void {
  authorityByPaneKey.clear()
  paneKeysBySessionKey.clear()
}

export function getWebSessionTerminalParkAuthorityCountForTests(): number {
  return authorityByPaneKey.size
}
