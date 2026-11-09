import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import { getRuntimeTargetForWorktreeOwner } from '@/lib/file-owner-runtime-target'
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

export type PluginBadgeWorktree = Pick<Worktree, 'id' | 'path' | 'hostId'>
export type PluginBadgeRepo = Pick<Repo, 'connectionId' | 'executionHostId'> | null | undefined

type PathTarget = { path: string; connectionId: string | null }
type PathCheck = { exists: boolean; checkedAt: number; pending: boolean }

// Why: a new workspace can still be syncing files when its card mounts, so a miss is re-checked.
const MISS_RECHECK_MS = 30_000

let checks: ReadonlyMap<string, PathCheck> = new Map()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getChecks(): ReadonlyMap<string, PathCheck> {
  return checks
}

function setCheck(key: string, check: PathCheck): void {
  checks = new Map(checks).set(key, check)
  listeners.forEach((listener) => listener())
}

function checkKey(target: PathTarget, relativePath: string): string {
  return `${target.connectionId ?? ''}\0${joinPath(target.path, relativePath)}`
}

function requestPathCheck(target: PathTarget, relativePath: string, now: number): void {
  const key = checkKey(target, relativePath)
  const previous = checks.get(key)
  if (
    previous &&
    (previous.pending || previous.exists || now - previous.checkedAt < MISS_RECHECK_MS)
  ) {
    return
  }
  setCheck(key, { exists: false, checkedAt: previous?.checkedAt ?? 0, pending: true })
  void window.api.fs
    .pathExists({
      filePath: joinPath(target.path, relativePath),
      ...(target.connectionId ? { connectionId: target.connectionId } : {})
    })
    // Why: an unreachable SSH host reads as a miss and is retried after the recheck delay.
    .catch(() => false)
    .then((exists) => setCheck(key, { exists, checkedAt: Date.now(), pending: false }))
}

/** Badges whose `when` matches the workspace. A new `recheckToken` (such as on activation)
 *  re-checks misses older than the recheck delay. */
export function useMatchingPluginWorktreeBadges(
  worktree: PluginBadgeWorktree,
  repo: PluginBadgeRepo,
  recheckToken?: unknown
): ActivePluginWorktreeBadge[] {
  const badges = usePluginWorktreeBadges()
  // Why: plugin commands run in this app's plugin host, which cannot reach a paired server's
  // workspaces, so their folders are never checked.
  const ownedHere = useAppStore(
    (state) =>
      badges.length > 0 && getRuntimeTargetForWorktreeOwner(state, worktree.id)?.kind === 'local'
  )
  const connectionId = getSshTargetIdForExecutionHost(
    getWorktreeExecutionHostId(worktree, repo ?? undefined)
  )
  const target = useMemo(
    () => (ownedHere && worktree.path ? { path: worktree.path, connectionId } : null),
    [ownedHere, worktree.path, connectionId]
  )
  const candidates = useMemo(
    () =>
      target ? badges.filter((badge) => badge.when.host === 'any' || !target.connectionId) : [],
    [badges, target]
  )
  const pathChecks = useSyncExternalStore(subscribe, getChecks, getChecks)

  useEffect(() => {
    if (!target) {
      return
    }
    const now = Date.now()
    for (const badge of candidates) {
      badge.when.pathExists.forEach((relativePath) => requestPathCheck(target, relativePath, now))
    }
  }, [candidates, target, recheckToken])

  return target
    ? candidates.filter((badge) =>
        badge.when.pathExists.some(
          (relativePath) => pathChecks.get(checkKey(target, relativePath))?.exists === true
        )
      )
    : []
}
