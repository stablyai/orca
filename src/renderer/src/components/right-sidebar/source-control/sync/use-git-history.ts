import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react'
import { BoundedMap } from '../../../../../../shared/collections/bounded-map'
import { requireGitOwnerTarget } from './worktree-git-owner-target'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { sourceControlConnectionId, useSourceControlScope } from '../panel/worktree-scope'
import { GIT_HISTORY_DEFAULT_LIMIT } from '../../../../../../shared/git/history/git-history-types'
import { getRuntimeGitHistory } from '@/runtime/source-control/git/runtime-git-status-client'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import { takeRecentWorkspaceSwitchWake } from '@/lib/workspace/activation/workspace-switch-user-act'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }
const LOADING_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'loading' }

/** `wakeWslDistro`: the user opening the scope menu, a user act that may start a stopped WSL distro. */
type HistoryRefresh = { wakeWslDistro?: boolean }
const SHOWN_HISTORY_LOAD: HistoryRefresh = { wakeWslDistro: true }

/** What a page answered for: null fields are resolved absence (unborn HEAD, no base), never "unknown". */
type GitHistoryPageKey = {
  owner: string
  headOid: string | null
  baseRef: string | null
  /** Resolved base OID of a branch page; null for a plain HEAD page. */
  baseOid: string | null
}
type GitHistoryEntry = { state: GitHistoryPanelState; key: GitHistoryPageKey | null }

/** The current context; `undefined` fields are not known yet, so no page can be trusted against them. */
type GitHistoryFence = {
  owner: string
  headOid: string | null | undefined
  baseRef: string | null
  /** Current resolved base OID from branch compare; undefined while compare is loading. */
  baseOid: string | null | undefined
}

// One session store shared by every panel instance: slots, the latest request per worktree, listeners.
const gitHistorySlots = new BoundedMap<string, GitHistoryEntry>({ maxEntries: 256 })
const latestGitHistoryRequest = new Map<string, number>()
const gitHistoryListeners = new Set<() => void>()
let gitHistoryRequestSeq = 0

function nextGitHistoryRequestId(): number {
  gitHistoryRequestSeq += 1
  return gitHistoryRequestSeq
}

function publishGitHistory(worktreeId: string, entry: GitHistoryEntry): void {
  gitHistorySlots.set(worktreeId, entry)
  for (const listener of gitHistoryListeners) {
    listener()
  }
}

function subscribeGitHistory(listener: () => void): () => void {
  gitHistoryListeners.add(listener)
  return () => gitHistoryListeners.delete(listener)
}

function pageKeyMatches(key: GitHistoryPageKey, fence: GitHistoryFence): boolean {
  if (fence.headOid === undefined || key.owner !== fence.owner || key.baseRef !== fence.baseRef) {
    return false
  }
  if (key.headOid !== fence.headOid) {
    return false
  }
  // A plain HEAD page does not depend on the base OID; a branch page needs the same resolved base.
  return key.baseOid === null || key.baseOid === fence.baseOid
}

/** Never show another host's, HEAD's or base's commits; a mismatched page reads as loading until replaced. */
function presentGitHistoryEntry(
  entry: GitHistoryEntry | undefined,
  fence: GitHistoryFence
): GitHistoryPanelState {
  if (!entry) {
    return EMPTY_GIT_HISTORY_STATE
  }
  const { state, key } = entry
  if (!state.result) {
    return state
  }
  if (key && pageKeyMatches(key, fence)) {
    return state
  }
  return state.status === 'error'
    ? { status: 'error', error: state.error }
    : LOADING_GIT_HISTORY_STATE
}

function pageKeyFor(result: GitHistoryResult, owner: string, baseRef: string | null) {
  return {
    owner,
    headOid: result.currentRef?.revision ?? null,
    baseRef,
    baseOid: result.branch?.baseRef.revision ?? null
  }
}

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
    for (const key of gitHistorySlots.keys()) {
      if (!worktreeMap.has(key)) {
        gitHistorySlots.delete(key)
        latestGitHistoryRequest.delete(key)
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
          key: pageKeyFor(result, owner, compareBaseRef),
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
