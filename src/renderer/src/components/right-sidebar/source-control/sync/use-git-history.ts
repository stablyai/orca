import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { requireGitOwnerTarget } from '../../worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitHistory } from '@/runtime/runtime-git-status-client'
import type { GitHistoryPanelState } from './git-history-panel'
import type { GitHistoryResult, GitHistoryScope } from '../../../../../../shared/git-history'

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }

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
  refreshGitHistory: () => Promise<void>
  loadMoreGitHistory: () => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
  gitHistoryScope: GitHistoryScope
  setGitHistoryScope: (scope: GitHistoryScope) => void
} {
  const [gitHistoryScope, setGitHistoryScope] = useState<GitHistoryScope>('all')
  const [gitHistoryByWorktree, setGitHistoryByWorktree] = useState<
    Record<string, GitHistoryPanelState>
  >({})
  const gitHistoryRequestSeqRef = useRef(0)
  const gitHistoryRequestByWorktreeRef = useRef<Record<string, number>>({})
  const pageRequestsRef = useRef<Record<string, number>>({})
  const loadedResultsRef = useRef<Record<string, GitHistoryResult>>({})
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
        delete pageRequestsRef.current[key]
        delete loadedResultsRef.current[key]
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
    delete loadedResultsRef.current[worktreeId]
    delete pageRequestsRef.current[worktreeId]
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
          includeRelatedRefs: gitHistoryScope === 'all',
          scope: gitHistoryScope
        }
      )
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      loadedResultsRef.current[worktreeId] = result
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
    activeRepoTarget,
    activeWorktreeId,
    compareBaseRef,
    gitHistoryScope,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    worktreePath
  ])
  const loadMoreGitHistory = useCallback(async (): Promise<void> => {
    const result = gitHistoryState.result
    if (
      !activeWorktreeId ||
      !worktreePath ||
      isFolder ||
      !isBranchVisible ||
      !isGitHistoryExpanded ||
      !isGitHistoryVisible ||
      gitHistoryState.status !== 'ready' ||
      !result?.hasMore ||
      !result.nextCursor ||
      loadedResultsRef.current[activeWorktreeId] !== result ||
      pageRequestsRef.current[activeWorktreeId] !== undefined
    ) {
      return
    }
    const worktreeId = activeWorktreeId
    const requestId = ++gitHistoryRequestSeqRef.current
    gitHistoryRequestByWorktreeRef.current[worktreeId] = requestId
    pageRequestsRef.current[worktreeId] = requestId
    setGitHistoryByWorktree((prev) => ({
      ...prev,
      [worktreeId]: { status: 'ready', result, isLoadingMore: true }
    }))
    try {
      const page = await getRuntimeGitHistory(
        {
          target: requireGitOwnerTarget(activeRepoTarget),
          worktreeId,
          worktreePath,
          connectionId: getConnectionId(worktreeId) ?? undefined
        },
        { limit: 50, cursor: result.nextCursor }
      )
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      const ids = new Set(result.items.map((item) => item.id))
      const additions = page.items.filter((item) => !ids.has(item.id))
      if (
        (!additions.length && page.hasMore) ||
        (page.nextCursor && page.nextCursor.offset <= result.nextCursor.offset)
      ) {
        throw new Error('History did not advance. Refresh commits to try again.')
      }
      const mergedResult = {
        ...result,
        items: [...result.items, ...additions],
        hasMore: page.hasMore,
        nextCursor: page.nextCursor
      }
      loadedResultsRef.current[worktreeId] = mergedResult
      setGitHistoryByWorktree((prev) => ({
        ...prev,
        [worktreeId]: {
          status: 'ready',
          result: mergedResult
        }
      }))
    } catch (error) {
      if (gitHistoryRequestByWorktreeRef.current[worktreeId] !== requestId) {
        return
      }
      setGitHistoryByWorktree((prev) => ({
        ...prev,
        [worktreeId]: {
          status: 'ready',
          result,
          loadMoreError: error instanceof Error ? error.message : 'Failed to load more commits'
        }
      }))
    } finally {
      if (pageRequestsRef.current[worktreeId] === requestId) {
        delete pageRequestsRef.current[worktreeId]
      }
    }
  }, [
    activeRepoTarget,
    activeWorktreeId,
    worktreePath,
    isFolder,
    isBranchVisible,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    gitHistoryState
  ])
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  // Publish before consumer effects, never during render where discarded renders could install callbacks.
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])

  useEffect(() => {
    // Defer Git subprocesses until Commits is expanded and visible, especially for large/remote repos.
    if (!isBranchVisible || !isGitHistoryExpanded || !isGitHistoryVisible) {
      return
    }
    void refreshGitHistoryRef.current()
  }, [
    // History uses compareBaseRef, which can move independently of effectiveBaseRef.
    activeWorktreeId,
    compareBaseRef,
    gitHistoryScope,
    isBranchVisible,
    isFolder,
    isGitHistoryExpanded,
    isGitHistoryVisible,
    // Owner changes can occur without worktree/path changes; refetch rather than retain another host’s commits.
    ownerHostKey,
    worktreePath
  ])

  return {
    gitHistoryState,
    refreshGitHistory,
    refreshGitHistoryRef,
    loadMoreGitHistory,
    gitHistoryScope,
    setGitHistoryScope
  }
}
