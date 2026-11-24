import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type RefObject
} from 'react'
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
  releasedHistorySlots,
  retireGitHistorySlot,
  subscribeGitHistory,
  presentGitHistoryEntry,
  pageKeyFor,
  type GitHistoryFence,
  type GitHistoryPanelState
} from './git-history-page-store'
export type { GitHistoryPanelState } from './git-history-page-store'

/** `wakeWslDistro`: the user opening the scope menu, a user act that may start a stopped WSL distro. */
type HistoryRefresh = { wakeWslDistro?: boolean }
const SHOWN_HISTORY_LOAD: HistoryRefresh = { wakeWslDistro: true }

/** Session-cached history per worktree and execution owner. */
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
  gitHistoryContextKey: string
  gitHistoryState: GitHistoryPanelState
  refreshGitHistory: (options?: HistoryRefresh) => Promise<void>
  refreshGitHistoryRef: RefObject<() => Promise<void>>
} {
  const scope = useSourceControlScope()
  const connectionId = activeWorktreeId
    ? sourceControlConnectionId(scope, activeWorktreeId)
    : undefined
  // The authority that answers: same worktree id on another runtime or SSH host is another page.
  const slotKey = JSON.stringify([
    activeWorktreeId,
    activeRepoTarget?.kind ?? null,
    activeRepoTarget?.kind === 'environment' ? activeRepoTarget.environmentId : null,
    connectionId ?? null
  ])
  const statusHeadOid = headOid === '(initial)' ? null : headOid
  const historyFence = useMemo<GitHistoryFence>(
    () => ({
      branchName,
      headOid: statusHeadOid,
      baseRef: compareBaseRef,
      baseOid: compareBaseOid
    }),
    [branchName, statusHeadOid, compareBaseRef, compareBaseOid]
  )
  const gitHistoryContextKey = JSON.stringify([
    slotKey,
    branchName,
    statusHeadOid,
    compareBaseRef,
    compareBaseOid
  ])
  const subscribeSlot = useCallback(
    (listener: () => void) => subscribeGitHistory(slotKey, listener),
    [slotKey]
  )
  const entry = useSyncExternalStore(subscribeSlot, () =>
    activeWorktreeId ? gitHistorySlots.get(slotKey) : undefined
  )
  const gitHistoryState = activeWorktreeId
    ? presentGitHistoryEntry(entry, historyFence)
    : EMPTY_GIT_HISTORY_STATE

  const consumesSlot = activeWorktreeId !== null && worktreeMap.has(activeWorktreeId)
  useEffect(() => {
    if (!consumesSlot) {
      return
    }
    mountedHistoryConsumers.set(slotKey, (mountedHistoryConsumers.get(slotKey) ?? 0) + 1)
    releasedHistorySlots.delete(slotKey)
    return () => {
      const remaining = (mountedHistoryConsumers.get(slotKey) ?? 1) - 1
      if (remaining) {
        mountedHistoryConsumers.set(slotKey, remaining)
      } else {
        mountedHistoryConsumers.delete(slotKey)
        releasedHistorySlots.add(slotKey)
      }
    }
  }, [consumesSlot, slotKey])

  // A catalog change (or mount) sweeps every retained request; a workspace switch checks only the
  // slots released since the last sweep, so it never walks the whole request map.
  // Declared after registration so a consumer whose worktree left the catalog has already released its slot.
  const sweptCatalogRef = useRef<ReadonlyMap<string, unknown> | null>(null)
  useEffect(() => {
    const candidates =
      sweptCatalogRef.current === worktreeMap
        ? [...releasedHistorySlots]
        : [...latestGitHistoryRequest.keys()]
    sweptCatalogRef.current = worktreeMap
    releasedHistorySlots.clear()
    for (const key of candidates) {
      const request = latestGitHistoryRequest.get(key)
      if (request && !worktreeMap.has(request.worktreeId) && !mountedHistoryConsumers.has(key)) {
        retireGitHistorySlot(key)
      }
    }
  }, [slotKey, worktreeMap])

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
      latestGitHistoryRequest.set(slotKey, { worktreeId, id: requestId })
      if (!mountedHistoryConsumers.has(slotKey)) {
        // No consumer holds this slot, so the next switch may retire it.
        releasedHistorySlots.add(slotKey)
      }
      const isLatest = (): boolean => latestGitHistoryRequest.get(slotKey)?.id === requestId
      const previous = gitHistorySlots.get(slotKey)
      // Keep the previous page while refreshing; the read fence hides it if it no longer applies.
      publishGitHistory(
        slotKey,
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
            connectionId
          },
          {
            limit: GIT_HISTORY_DEFAULT_LIMIT,
            baseRef: compareBaseRef,
            // Commits the base lacks, without the pushed state, statistics or counts the menu never shows.
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
        publishGitHistory(slotKey, {
          key: pageKeyFor(result, historyFence),
          state: { status: 'ready', result }
        })
      } catch (error) {
        if (!isLatest()) {
          return
        }
        const message = error instanceof Error ? error.message : 'Failed to load commits'
        const current = gitHistorySlots.get(slotKey)
        publishGitHistory(
          slotKey,
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
      activeRepoTarget,
      activeWorktreeId,
      compareBaseRef,
      connectionId,
      historyFence,
      isBranchVisible,
      isFolder,
      isGitHistoryNeeded,
      isGitHistoryVisible,
      slotKey,
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
  const lastExpandedRef = useRef({ slotKey, expanded: isGitHistoryNeeded })
  useEffect(() => {
    const last = lastExpandedRef.current
    const userExpanded = isGitHistoryNeeded && !last.expanded && last.slotKey === slotKey
    lastExpandedRef.current = { slotKey, expanded: isGitHistoryNeeded }
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
    statusHeadOid,
    isBranchVisible,
    isFolder,
    isGitHistoryNeeded,
    isGitHistoryVisible,
    // Owner changes can occur without worktree/path changes; refetch rather than retain another host’s commits.
    slotKey,
    // A same-name base that moved (fetch) changes the range even with HEAD unchanged.
    compareBaseOid,
    worktreePath
  ])

  return { gitHistoryContextKey, gitHistoryState, refreshGitHistory, refreshGitHistoryRef }
}
