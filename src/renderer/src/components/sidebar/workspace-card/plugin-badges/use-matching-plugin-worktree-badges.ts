import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/files/access/file-owner-runtime-target'
import {
  usePluginWorktreeBadges,
  type ActivePluginWorktreeBadge
} from '@/store/plugins/worktree-badges/plugin-worktree-badges'
import {
  getSshTargetIdForExecutionHost,
  getWorktreeExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { findPluginBadgeFolders, type PluginBadgeSearchRoot } from './plugin-badge-folder-search'

export type PluginBadgeWorktree = Pick<Worktree, 'id' | 'path' | 'hostId'>
export type PluginBadgeRepo = Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined

/** A badge matching a workspace, with the folders that hold its marker; `''` is the workspace
 *  folder itself. */
export type PluginWorktreeBadgeMatch = {
  badge: ActivePluginWorktreeBadge
  folders: readonly string[]
}

type BadgeWhen = ActivePluginWorktreeBadge['when']
type FolderScan = { folders: readonly string[]; checkedAt: number; pending: boolean }

// Why: a new workspace can still be syncing files when its card mounts, so a scan is repeated.
const RESCAN_AFTER_MS = 30_000

let scans: ReadonlyMap<string, FolderScan> = new Map()
const listeners = new Set<() => void>()

/** Registers a `useSyncExternalStore` listener for scan changes; returns its unsubscribe. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The current scans snapshot; replaced, never mutated, so React sees each change. */
function getScans(): ReadonlyMap<string, FolderScan> {
  return scans
}

/** Records one scan in a new snapshot and notifies every subscribed card. */
function setScan(key: string, scan: FolderScan): void {
  scans = new Map(scans).set(key, scan)
  listeners.forEach((listener) => listener())
}

/** Identifies a scan by host, root and the search it runs, so badges with the same `when` share it. */
function scanKey(root: PluginBadgeSearchRoot, when: BadgeWhen): string {
  return [root.connectionId ?? '', root.path, when.searchDepth, ...when.pathExists].join('\0')
}

/** Starts a folder scan unless one is running or the last finished under `RESCAN_AFTER_MS` ago. */
function requestFolderScan(root: PluginBadgeSearchRoot, when: BadgeWhen, now: number): void {
  const key = scanKey(root, when)
  const previous = scans.get(key)
  if (previous && (previous.pending || now - previous.checkedAt < RESCAN_AFTER_MS)) {
    return
  }
  // Why keep the folders: the badge must not flicker while a rescan runs.
  setScan(key, {
    folders: previous?.folders ?? [],
    checkedAt: previous?.checkedAt ?? 0,
    pending: true
  })
  void findPluginBadgeFolders(root, when)
    .catch(() => [])
    .then((folders) => setScan(key, { folders, checkedAt: Date.now(), pending: false }))
}

/** Badges whose `when` matches the workspace. A new `recheckToken` (such as on activation)
 *  repeats scans older than the rescan delay. */
export function useMatchingPluginWorktreeBadges(
  worktree: PluginBadgeWorktree,
  repo: PluginBadgeRepo,
  recheckToken?: unknown
): PluginWorktreeBadgeMatch[] {
  const badges = usePluginWorktreeBadges()
  // Why: plugin commands run in this app's plugin host, which cannot reach a paired server's
  // workspaces, so their folders are never searched.
  const ownedHere = useAppStore(
    (state) =>
      badges.length > 0 && getRuntimeTargetForWorktreeOwner(state, worktree.id)?.kind === 'local'
  )
  const connectionId = getSshTargetIdForExecutionHost(
    getWorktreeExecutionHostId(worktree, repo ?? undefined)
  )
  const root = useMemo(
    () => (ownedHere && worktree.path ? { path: worktree.path, connectionId } : null),
    [ownedHere, worktree.path, connectionId]
  )
  const candidates = useMemo(
    () => (root ? badges.filter((badge) => badge.when.host === 'any' || !root.connectionId) : []),
    [badges, root]
  )
  const folderScans = useSyncExternalStore(subscribe, getScans, getScans)

  useEffect(() => {
    if (!root) {
      return
    }
    const now = Date.now()
    candidates.forEach((badge) => requestFolderScan(root, badge.when, now))
  }, [candidates, root, recheckToken])

  return useMemo(
    () =>
      root
        ? candidates.flatMap((badge) => {
            const folders = folderScans.get(scanKey(root, badge.when))?.folders ?? []
            return folders.length > 0 ? [{ badge, folders }] : []
          })
        : [],
    [candidates, root, folderScans]
  )
}
