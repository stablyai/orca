import { useContext, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { NativeChatOwnerWorktreeContext } from '@/components/native-chat/pane/ownership/native-chat-owner-worktree-context'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import {
  resolveWorktreeGitCopyNow,
  worktreeCopyPushTarget
} from '@/lib/workspace/ownership/worktree-git-copy'
import { refreshGitStatusForWorktree } from '@/components/right-sidebar/source-control/sync/git-status-refresh'
import { getRelativePathInsideRoot } from '@/lib/path'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type {
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'

export type NativeChatTurnDiffGitState = {
  /** Turn-diff paths still carrying uncommitted changes. */
  uncommittedPaths: ReadonlySet<string>
  /** Uncommitted paths whose live diff line counts no longer match the turn's recorded diff. */
  divergedPaths: ReadonlySet<string>
  uncommittedCount: number
  committedCount: number
  /** True when the upstream reports no unpushed commits; null when push state is unknown. */
  allPushed: boolean | null
}

type DirtyObservation = {
  /** Status HEAD from the last read where the path was dirty. */
  head: string
  /** The path left the dirty set without a HEAD move: the recorded edit was reverted or stashed, not committed. */
  vanishedSameHead: boolean
}

// Per-worktree observation cache: a path that goes dirty then clean can only claim "committed"
// when HEAD moved while it was clean. Paths never observed dirty keep the legacy committed
// assumption (their turn predates this app session's first status read).
const dirtyObservations = new Map<string, Map<string, DirtyObservation>>()

/** Cards claim nothing about commit state until this worktree's status has been read once. */
export function nativeChatTurnDiffGitState(
  diff: NativeChatTurnDiff,
  entries: readonly GitStatusEntry[] | undefined,
  upstream: GitUpstreamStatus | undefined,
  worktreePath: string | undefined,
  statusHead: string | undefined,
  worktreeId: string | undefined,
  statusCapped = false
): NativeChatTurnDiffGitState | null {
  if (entries === undefined || worktreePath === undefined) {
    return null
  }
  const dirty = new Set<string>()
  for (const entry of entries) {
    dirty.add(entry.path)
    if (entry.oldPath) {
      dirty.add(entry.oldPath)
    }
  }
  const observed = worktreeId ? dirtyObservations.get(worktreeId) : undefined
  const uncommittedPaths = new Set<string>()
  const divergedPaths = new Set<string>()
  let committedCount = 0
  for (const file of diff.files) {
    // Status paths are repo-relative; edit paths are whatever the tool call carried (often absolute).
    const relative = getRelativePathInsideRoot(file.path, worktreePath)
    if (dirty.has(file.path) || dirty.has(relative ?? '')) {
      uncommittedPaths.add(file.path)
      // Same counts is the recorded diff still live; different counts means the
      // worktree moved on since the turn. Unknown counts say nothing.
      if (!file.truncated) {
        let liveAdded = 0
        let liveRemoved = 0
        let known = false
        for (const entry of entries) {
          const matches =
            entry.path === file.path ||
            entry.path === relative ||
            entry.oldPath === file.path ||
            entry.oldPath === relative
          if (!matches) {
            continue
          }
          if (entry.added === undefined || entry.removed === undefined) {
            // One staging area without counts makes the live total unknowable.
            known = false
            break
          }
          known = true
          liveAdded += entry.added
          liveRemoved += entry.removed
        }
        if (known && (liveAdded !== file.added || liveRemoved !== file.removed)) {
          divergedPaths.add(file.path)
        }
      }
      if (statusHead !== undefined && worktreeId !== undefined) {
        let files = dirtyObservations.get(worktreeId)
        if (files === undefined) {
          files = new Map()
          dirtyObservations.set(worktreeId, files)
        }
        files.set(file.path, { head: statusHead, vanishedSameHead: false })
      }
      continue
    }
    // A capped status stops mid-list: absence proves nothing, so claim and mark nothing.
    if (statusCapped) {
      continue
    }
    const last = observed?.get(file.path)
    if (statusHead !== undefined && last !== undefined) {
      if (last.vanishedSameHead) {
        continue
      }
      if (last.head === statusHead) {
        // Vanished while HEAD stayed put: reverted or stashed, not committed — stay unknown.
        last.vanishedSameHead = true
        continue
      }
    }
    committedCount += 1
  }
  return {
    uncommittedPaths,
    divergedPaths,
    uncommittedCount: uncommittedPaths.size,
    committedCount,
    allPushed:
      upstream?.hasUpstream === true &&
      upstream.head !== undefined &&
      statusHead !== undefined &&
      upstream.head === statusHead
        ? upstream.ahead === 0
        : null
  }
}

const TURN_DIFF_GIT_REFRESH_MIN_INTERVAL_MS = 10_000
const refreshRequestedAt = new Map<string, number>()
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>()
const refreshConsumers = new Map<string, number>()

/** Every rendered turn diff keeps its worktree's status current, at a background pace. */
function ensureTurnDiffGitStatus(worktreeId: string): void {
  const now = Date.now()
  const remaining =
    TURN_DIFF_GIT_REFRESH_MIN_INTERVAL_MS - (now - (refreshRequestedAt.get(worktreeId) ?? 0))
  if (remaining > 0) {
    // A dropped request must not leave the card stale: coalesce into one trailing refresh.
    if (!pendingRefresh.has(worktreeId)) {
      pendingRefresh.set(
        worktreeId,
        setTimeout(() => {
          pendingRefresh.delete(worktreeId)
          ensureTurnDiffGitStatus(worktreeId)
        }, remaining)
      )
    }
    return
  }
  refreshRequestedAt.set(worktreeId, now)
  void (async () => {
    try {
      const state = useAppStore.getState()
      const copy = resolveWorktreeGitCopyNow(worktreeId)
      const worktreePath = selectKnownWorktreeById(state, worktreeId)?.path
      if (!copy || !worktreePath) {
        return
      }
      await refreshGitStatusForWorktree({
        target: copy.transport,
        ownerHostId: copy.hostId,
        worktreeId,
        worktreePath,
        connectionId: copy.connectionId,
        pushTarget: worktreeCopyPushTarget(state, worktreeId, copy.hostId),
        deps: state,
        request: { admissionTier: 'background' }
      })
    } catch {
      // Missing or stale markers are preferable to noise from a worktree that cannot be read.
    }
  })()
}

/** Maps a turn diff onto the owning worktree's live commit state; null while status is unread. */
export function useNativeChatTurnDiffGitState(
  diff: NativeChatTurnDiff
): NativeChatTurnDiffGitState | null {
  const worktreeId = useContext(NativeChatOwnerWorktreeContext)
  const entries = useAppStore((s) => (worktreeId ? s.gitStatusByWorktree[worktreeId] : undefined))
  const upstream = useAppStore((s) =>
    worktreeId ? s.remoteStatusesByWorktree[worktreeId] : undefined
  )
  const statusHead = useAppStore((s) =>
    worktreeId ? s.gitStatusHeadByWorktree[worktreeId] : undefined
  )
  const statusCapped = useAppStore((s) =>
    worktreeId ? s.gitStatusHugeByWorktree[worktreeId] !== undefined : false
  )
  const worktreePath = useAppStore((s) =>
    worktreeId ? selectKnownWorktreeById(s, worktreeId)?.path : undefined
  )
  useEffect(() => {
    if (!worktreeId) {
      return
    }
    // Only the last consumer may cancel the shared trailing timer.
    refreshConsumers.set(worktreeId, (refreshConsumers.get(worktreeId) ?? 0) + 1)
    return () => {
      const remaining = (refreshConsumers.get(worktreeId) ?? 1) - 1
      if (remaining > 0) {
        refreshConsumers.set(worktreeId, remaining)
        return
      }
      refreshConsumers.delete(worktreeId)
      const pending = pendingRefresh.get(worktreeId)
      if (pending !== undefined) {
        clearTimeout(pending)
        pendingRefresh.delete(worktreeId)
      }
    }
  }, [worktreeId])
  useEffect(() => {
    if (worktreeId) {
      ensureTurnDiffGitStatus(worktreeId)
    }
  }, [worktreeId, diff])
  return useMemo(
    () =>
      nativeChatTurnDiffGitState(
        diff,
        entries,
        upstream,
        worktreePath,
        statusHead,
        worktreeId ?? undefined,
        statusCapped
      ),
    [diff, entries, upstream, worktreePath, statusHead, worktreeId, statusCapped]
  )
}
