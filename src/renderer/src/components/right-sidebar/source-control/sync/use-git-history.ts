import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitHistory, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { GitHistoryPanelState } from './git-history-panel'

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }

/**
 * Loads commit history for the active worktree.
 *
 * State is kept per worktree so switching tabs restores the previous result instead of reloading,
 * and entries are pruned when `worktreeMap` drops a worktree. Fetching is gated on the panel being
 * expanded and visible, and stale responses are discarded by per-worktree request id.
 *
 * `refreshGitHistoryRef` exists for callers that must refresh from an effect without re-subscribing
 * whenever the callback identity changes.
 */
export function useSourceControlGitHistory({
  activeRepoSettings,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  isBranchVisible,
  isGitHistoryExpanded,
  isGitHistoryVisible,
  worktreeMap
}: {
  activeRepoSettings: RuntimeGitContext['settings']
  activeWorktreeId: string | null
  worktreePath: string | null
  compareBaseRef: string | null
  isFolder: boolean
  isBranchVisible: boolean
  isGitHistoryExpanded: boolean
  isGitHistoryVisible: boolean
  worktreeMap: ReadonlyMap<string, unknown>
}): {
  gitHistoryState: GitHistoryPanelState
  refreshGitHistory: () => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
} {
  const [gitHistoryByWorktree, setGitHistoryByWorktree] = useState<
    Record<string, GitHistoryPanelState>
  >({})
  const gitHistoryRequestSeqRef = useRef(0)
  const gitHistoryRequestByWorktreeRef = useRef<Record<string, number>>({})
  const gitHistoryState = activeWorktreeId
    ? (gitHistoryByWorktree[activeWorktreeId] ?? EMPTY_GIT_HISTORY_STATE)
    : EMPTY_GIT_HISTORY_STATE
  // Why: the read is routed by owner host, so track it as a stable string — a new settings object alone must not refetch.
  const ownerHostKey = activeRepoSettings?.activeRuntimeEnvironmentId?.trim() ?? ''

  useEffect(() => {
    setGitHistoryByWorktree((prev) => {
      let changed = false
      const next: Record<string, GitHistoryPanelState> = {}
      for (const key of Object.keys(prev)) {
        if (worktreeMap.has(key)) {
          next[key] = prev[key]
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
    for (const key of Object.keys(gitHistoryRequestByWorktreeRef.current)) {
      if (!worktreeMap.has(key)) {
        delete gitHistoryRequestByWorktreeRef.current[key]
      }
    }
  }, [worktreeMap])

  const refreshGitHistory = useCallback(async (): Promise<void> => {
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      !isBranchVisible ||
      !isGitHistoryExpanded ||
      !isGitHistoryVisible
    ) {
      return
    }
    const worktreeId = activeWorktreeId
    const requestId = gitHistoryRequestSeqRef.current + 1
    gitHistoryRequestSeqRef.current = requestId
    gitHistoryRequestByWorktreeRef.current[worktreeId] = requestId
    setGitHistoryByWorktree((prev) => {
      const previous = prev[worktreeId]
      return {
        ...prev,
        [worktreeId]: previous?.result
          ? { status: 'refreshing', result: previous.result }
          : { status: 'loading' }
      }
    })
    try {
      const connectionId = getConnectionId(worktreeId) ?? undefined
      const result = await getRuntimeGitHistory(
        {
          // Why: route the history read by the repo OWNER host, not the focused runtime.
          settings: activeRepoSettings,
          worktreeId,
          worktreePath,
          connectionId
        },
        { limit: 50, baseRef: compareBaseRef }
      )
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      setGitHistoryByWorktree((prev) => ({
        ...prev,
        [worktreeId]: { status: 'ready', result }
      }))
    } catch (error) {
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      const message = error instanceof Error ? error.message : 'Failed to load commits'
      setGitHistoryByWorktree((prev) => {
        const previous = prev[worktreeId]
        return {
          ...prev,
          [worktreeId]: previous?.result
            ? { status: 'error', result: previous.result, error: message }
            : { status: 'error', error: message }
        }
      })
    }
  }, [
    activeRepoSettings,
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreePath
  ])
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  // Why: publish in an effect, not the render body — a discarded render must not install its callback. Declared first so the effect below sees the fresh one.
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])

  useEffect(() => {
    // Why: history shells out to git; defer first load until the user expands Commits so source control stays cheap for large/remote repos.
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    void refreshGitHistoryRef.current()
  }, [
    // Why: history is fetched with compareBaseRef, so re-run when it changes (effectiveBaseRef can stay put while it moves).
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    // Why: same worktree + path can switch owner host; without this the panel keeps the previous host's commits.
    ownerHostKey,
    worktreePath
  ])

  return { gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
