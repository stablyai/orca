import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import type { GitHistoryPanelState } from './git-history-panel'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace-switch-user-act'

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }

/** `wakeWslDistro`: the user opening Commits or its Refresh, a user act that may start a stopped WSL distro. */
type HistoryRefresh = { wakeWslDistro?: boolean }
const SHOWN_HISTORY_LOAD: HistoryRefresh = { wakeWslDistro: true }

/** Cache/prune history per worktree and reject superseded requests; refreshGitHistoryRef lets effects refresh without callback resubscription. */
export function useSourceControlGitHistory({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  compareBaseRef,
  isFolder,
  isBranchVisible,
  isGitHistoryExpanded,
  isGitHistoryVisible,
  worktreeMap
}: {
  activeRepoTarget: RuntimeClientTarget | null
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
  refreshGitHistory: (options?: HistoryRefresh) => Promise<void>
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
  // Use stable owner identity so settings-object replacement cannot refetch history.
  const ownerHostKey =
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : ''

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

  const refreshGitHistory = useCallback(
    async (options?: HistoryRefresh): Promise<void> => {
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
            // Read history on the repo owner, which may differ from the focused host.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId,
            worktreePath,
            connectionId
          },
          {
            limit: 50,
            baseRef: compareBaseRef,
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          }
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
    },
    [
      activeRepoTarget,
      activeWorktreeId,
      compareBaseRef,
      isBranchVisible,
      isFolder,
      isGitHistoryExpanded,
      isGitHistoryVisible,
      worktreePath
    ]
  )
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  // Publish before consumer effects, never during render where discarded renders could install callbacks.
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])

  // Expanded at mount, or restored with another worktree's view, is not a click: only an expand
  // within the same worktree counts as the user opening Commits.
  const lastExpandedRef = useRef({ worktreeId: activeWorktreeId, expanded: isGitHistoryExpanded })
  useEffect(() => {
    const last = lastExpandedRef.current
    const userExpanded =
      isGitHistoryExpanded && !last.expanded && last.worktreeId === activeWorktreeId
    lastExpandedRef.current = { worktreeId: activeWorktreeId, expanded: isGitHistoryExpanded }
    // Defer Git subprocesses until Commits is expanded and visible, especially for large/remote repos.
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    // Only the user's own act may start a stopped WSL distro: opening Commits, or switching to this
    // workspace (once per switch). A remount, restore or Orca's own re-show stays background (E9).
    const userAct =
      userExpanded ||
      (activeWorktreeId !== null && takeRecentWorkspaceSwitchWake(activeWorktreeId, 'git-history'))
    void refreshGitHistoryRef.current(userAct ? SHOWN_HISTORY_LOAD : undefined)
  }, [
    // History uses compareBaseRef, which can move independently of effectiveBaseRef.
    activeWorktreeId,
    compareBaseRef,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    // Owner changes can occur without worktree/path changes; refetch rather than retain another host’s commits.
    ownerHostKey,
    worktreePath
  ])

  return { gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
