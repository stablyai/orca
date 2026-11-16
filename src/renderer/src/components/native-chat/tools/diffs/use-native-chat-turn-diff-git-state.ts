import { useContext, useEffect, useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { NativeChatOwnerWorktreeContext } from '@/components/native-chat/pane/ownership/native-chat-owner-worktree-context'
import { selectKnownWorktreeById } from '@/store/workspaces/selection/known-worktree-selection'
import {
  resolveWorktreeGitCopyNow,
  worktreeCopyPushTarget
} from '@/lib/workspace/ownership/worktree-git-copy'
import { refreshGitStatusForWorktree } from '@/components/right-sidebar/source-control/sync/git-status-refresh'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import type {
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../../../shared/git/status/git-status-types'

export type NativeChatTurnDiffGitState = {
  /** Turn-diff paths still carrying uncommitted changes. */
  uncommittedPaths: ReadonlySet<string>
  uncommittedCount: number
  committedCount: number
  /** True when the upstream reports no unpushed commits; null when push state is unknown. */
  allPushed: boolean | null
}

/** Cards claim nothing about commit state until this worktree's status has been read once. */
export function nativeChatTurnDiffGitState(
  diff: NativeChatTurnDiff,
  entries: readonly GitStatusEntry[] | undefined,
  upstream: GitUpstreamStatus | undefined
): NativeChatTurnDiffGitState | null {
  if (entries === undefined) {
    return null
  }
  const dirty = new Set<string>()
  for (const entry of entries) {
    dirty.add(entry.path)
    if (entry.oldPath) {
      dirty.add(entry.oldPath)
    }
  }
  const uncommittedPaths = new Set<string>()
  for (const file of diff.files) {
    if (dirty.has(file.path)) {
      uncommittedPaths.add(file.path)
    }
  }
  return {
    uncommittedPaths,
    uncommittedCount: uncommittedPaths.size,
    committedCount: diff.files.length - uncommittedPaths.size,
    allPushed: upstream?.hasUpstream === true ? upstream.ahead === 0 : null
  }
}

const TURN_DIFF_GIT_REFRESH_MIN_INTERVAL_MS = 10_000
const refreshRequestedAt = new Map<string, number>()

/** Every rendered turn diff keeps its worktree's status current, at a background pace. */
function ensureTurnDiffGitStatus(worktreeId: string): void {
  const now = Date.now()
  if (now - (refreshRequestedAt.get(worktreeId) ?? 0) < TURN_DIFF_GIT_REFRESH_MIN_INTERVAL_MS) {
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
  useEffect(() => {
    if (worktreeId) {
      ensureTurnDiffGitStatus(worktreeId)
    }
  }, [worktreeId, diff])
  return useMemo(
    () => nativeChatTurnDiffGitState(diff, entries, upstream),
    [diff, entries, upstream]
  )
}
