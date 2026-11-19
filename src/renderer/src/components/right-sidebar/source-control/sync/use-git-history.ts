import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import { GIT_HISTORY_DEFAULT_LIMIT } from '../../../../../../shared/git/history/git-history-types'
import { getRuntimeGitHistory } from '@/runtime/source-control/git/runtime-git-status-client'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace/activation/workspace-switch-user-act'

import {
  EMPTY_GIT_HISTORY_STATE,
  LOADING_GIT_HISTORY_STATE,
  gitHistorySlots,
  latestGitHistoryRequest,
  mountedHistoryConsumers,
  nextGitHistoryRequestId,
  publishGitHistory,
  subscribeGitHistory,
  presentGitHistoryEntry,
  pageKeyFor,
  type GitHistoryPanelState
} from './git-history-page-store'
export type { GitHistoryPanelState } from './git-history-page-store'

/** `wakeWslDistro`: the user opening the scope menu, a user act that may start a stopped WSL distro. */
type HistoryRefresh = { wakeWslDistro?: boolean }
const SHOWN_HISTORY_LOAD: HistoryRefresh = { wakeWslDistro: true }

/** Session-cached history per worktree with one publication authority; refreshGitHistoryRef lets effects refresh without callback resubscription. */
export function useSourceControlGitHistory({
  activeRepoTarget,
  activeWorktreeId,
  worktreePath,
  branchName,
  compareBaseRef,
  compareBaseOid,
  headOid,
  isFolder,
  isBranchVisible,
  isGitHistoryNeeded,
  isGitHistoryVisible,
  worktreeMap
}: {
  activeRepoTarget: RuntimeClientTarget | null
  activeWorktreeId: string | null
  worktreePath: string | null
  branchName: string
  compareBaseRef: string | null
  /** Branch compare's resolved base OID: undefined while loading, null when it has none. */
  compareBaseOid: string | null | undefined
  /** Git status HEAD: undefined until status is read, null for an unborn HEAD. */
  headOid: string | null | undefined
  isFolder: boolean
  isBranchVisible: boolean
  isGitHistoryNeeded: boolean
  isGitHistoryVisible: boolean
  worktreeMap: ReadonlyMap<string, unknown>
}): {
  gitHistoryState: GitHistoryPanelState
  refreshGitHistory: (options?: HistoryRefresh) => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
} {
  const scope = useSourceControlScope()
  const connectionId = activeWorktreeId
    ? sourceControlConnectionId(scope, activeWorktreeId)
    : undefined
  // The authority that answers: same worktree id on another runtime or SSH host is another page.
  const owner = JSON.stringify([
    activeRepoTarget?.kind ?? null,
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null,
    connectionId ?? null
  ])
  const entry = useSyncExternalStore(subscribeGitHistory, () =>
    activeWorktreeId ? gitHistorySlots.get(activeWorktreeId) : undefined
  )
  const gitHistoryState = activeWorktreeId
    ? presentGitHistoryEntry(entry, {
        owner,
        headOid,
        baseRef: compareBaseRef,
        baseOid: compareBaseOid
      })
    : EMPTY_GIT_HISTORY_STATE

  useEffect(() => {
    const mountedId =
      activeWorktreeId && worktreeMap.has(activeWorktreeId) ? activeWorktreeId : null
    if (mountedId) {
      mountedHistoryConsumers.set(mountedId, (mountedHistoryConsumers.get(mountedId) ?? 0) + 1)
    }
    for (const key of latestGitHistoryRequest.keys()) {
      if (!worktreeMap.has(key) && !mountedHistoryConsumers.has(key)) {
        gitHistorySlots.delete(key)
        latestGitHistoryRequest.delete(key)
      }
    }
    return () => {
      if (!mountedId) {
        return
      }
      const remaining = (mountedHistoryConsumers.get(mountedId) ?? 1) - 1
      if (remaining) {
        mountedHistoryConsumers.set(mountedId, remaining)
      } else {
        mountedHistoryConsumers.delete(mountedId)
      }
    }
  }, [activeWorktreeId, worktreeMap])

  const refreshGitHistory = useCallback(
    async (options?: HistoryRefresh): Promise<void> => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        isFolder ||
        !isBranchVisible ||
        !isGitHistoryNeeded ||
        !isGitHistoryVisible
      ) {
        return
      }
      const worktreeId = activeWorktreeId
      const requestId = nextGitHistoryRequestId()
      latestGitHistoryRequest.set(worktreeId, requestId)
      const isLatest = (): boolean => latestGitHistoryRequest.get(worktreeId) === requestId
      const previous = gitHistorySlots.get(worktreeId)
      // Keep the previous page while refreshing; the read fence hides it if it no longer applies.
      publishGitHistory(
        worktreeId,
        previous?.state.result
          ? { ...previous, state: { status: 'refreshing', result: previous.state.result } }
          : { key: null, state: LOADING_GIT_HISTORY_STATE }
      )
      const readPage = () =>
        getRuntimeGitHistory(
          {
            // Read history on the repo owner, which may differ from the focused host.
            target: requireGitOwnerTarget(activeRepoTarget),
            worktreeId,
            worktreePath,
            connectionId: sourceControlConnectionId(scope, worktreeId)
          },
          {
            limit: GIT_HISTORY_DEFAULT_LIMIT,
            baseRef: compareBaseRef,
            // Commits the base lacks, without per-row pushed/stat work the menu never shows.
            branchOnly: true,
            branchListOnly: true,
            ...(options?.wakeWslDistro ? { wakeWslDistro: true } : {})
          }
        )
      try {
        const result = await readPage()
        if (!isLatest()) {
          return
        }
        publishGitHistory(worktreeId, {
          key: pageKeyFor(result, owner, compareBaseRef, compareBaseOid),
          state: { status: 'ready', result }
        })
      } catch (error) {
        if (!isLatest()) {
          return
        }
        const message = error instanceof Error ? error.message : 'Failed to load commits'
        const current = gitHistorySlots.get(worktreeId)
        publishGitHistory(
          worktreeId,
          current?.state.result
            ? {
                ...current,
                state: { status: 'error', result: current.state.result, error: message }
              }
            : { key: null, state: { status: 'error', error: message } }
        )
      }
    },
    [
      scope,
      activeRepoTarget,
      activeWorktreeId,
      compareBaseRef,
      compareBaseOid,
      isBranchVisible,
      isFolder,
      isGitHistoryNeeded,
      isGitHistoryVisible,
      owner,
      worktreePath
    ]
  )
  const refreshGitHistoryRef = useRef(refreshGitHistory)
  // Publish before consumer effects, never during render where discarded renders could install callbacks.
  useEffect(() => {
    refreshGitHistoryRef.current = refreshGitHistory
  }, [refreshGitHistory])

  // Needed at mount, or restored with another worktree's view, is not a click: only a change
  // within the same worktree counts as the user opening the scope menu.
  const lastExpandedRef = useRef({ worktreeId: activeWorktreeId, expanded: isGitHistoryNeeded })
  useEffect(() => {
    const last = lastExpandedRef.current
    const userExpanded =
      isGitHistoryNeeded && !last.expanded && last.worktreeId === activeWorktreeId
    lastExpandedRef.current = { worktreeId: activeWorktreeId, expanded: isGitHistoryNeeded }
    // Defer Git subprocesses until the menu or a picked commit needs them, especially for large/remote repos.
    if (!isBranchVisible || !isGitHistoryNeeded || !isGitHistoryVisible) {
      return
    }
    // Only the user's own act may start a stopped WSL distro: opening the scope menu, or switching to this
    // workspace (once per switch). A remount, restore or Orca's own re-show stays background (E9).
    const userAct =
      userExpanded ||
      (activeWorktreeId !== null && takeRecentWorkspaceSwitchWake(activeWorktreeId, 'git-history'))
    void refreshGitHistoryRef.current(userAct ? SHOWN_HISTORY_LOAD : undefined)
  }, [
    // History uses compareBaseRef, which can move independently of effectiveBaseRef.
    activeWorktreeId,
    // A branch switch keeps the workspace and path; the open list must follow the new branch.
    branchName,
    compareBaseRef,
    // A rebase or reset in a terminal must drop a picked commit that is no longer on the branch.
    headOid,
    isBranchVisible,
    isFolder,
    isGitHistoryNeeded,
    isGitHistoryVisible,
    // Owner changes can occur without worktree/path changes; refetch rather than retain another host’s commits.
    owner,
    // A same-name base that moved (fetch) changes the range even with HEAD unchanged.
    compareBaseOid,
    worktreePath
  ])

  return { gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
