import { BoundedMap } from '../../../../../../shared/collections/bounded-map'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error: string }

export const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }
export const LOADING_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'loading' }

/** What a page answered for: null fields are resolved absence (unborn HEAD, no base), never "unknown". */
type GitHistoryPageKey = {
  branchName: string
  headOid: string | null
  baseRef: string | null
  /** Resolved base OID of a branch page; null for a plain HEAD page. */
  baseOid: string | null
  requestedBaseOid: string | null | undefined
}
type GitHistoryEntry = { state: GitHistoryPanelState; key: GitHistoryPageKey | null }

/** The current context; `undefined` fields are not known yet, so no page can be trusted against them. */
export type GitHistoryFence = {
  branchName: string
  headOid: string | null | undefined
  baseRef: string | null
  /** Current resolved base OID from branch compare; undefined while compare is loading. */
  baseOid: string | null | undefined
}

// Share each worktree and execution owner’s history across panel remounts.
export const gitHistorySlots = new BoundedMap<string, GitHistoryEntry>({ maxEntries: 256 })
export const latestGitHistoryRequest = new Map<string, { worktreeId: string; id: number }>()
export const mountedHistoryConsumers = new Map<string, number>()
const gitHistoryListeners = new Set<() => void>()
let gitHistoryRequestSeq = 0

export function nextGitHistoryRequestId(): number {
  gitHistoryRequestSeq += 1
  return gitHistoryRequestSeq
}

export function publishGitHistory(slotKey: string, entry: GitHistoryEntry): void {
  gitHistorySlots.set(slotKey, entry)
  for (const listener of gitHistoryListeners) {
    listener()
  }
}

export function subscribeGitHistory(listener: () => void): () => void {
  gitHistoryListeners.add(listener)
  return () => gitHistoryListeners.delete(listener)
}

function pageKeyMatches(key: GitHistoryPageKey, fence: GitHistoryFence): boolean {
  if (
    fence.headOid === undefined ||
    key.branchName !== fence.branchName ||
    key.baseRef !== fence.baseRef
  ) {
    return false
  }
  if (key.headOid !== fence.headOid) {
    return false
  }
  // A plain HEAD page does not depend on the base OID; a branch page needs the same resolved base.
  return key.baseOid === null
    ? key.requestedBaseOid === fence.baseOid
    : key.baseOid === fence.baseOid
}

/** Never show another host's, HEAD's or base's commits; a mismatched page reads as loading until replaced. */
export function presentGitHistoryEntry(
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

export function pageKeyFor(
  result: GitHistoryResult,
  requestedBranchName: string,
  baseRef: string | null,
  requestedBaseOid: string | null | undefined
) {
  const currentRef = result.currentRef
  const branchPrefix = 'refs/heads/'
  return {
    branchName: currentRef?.id.startsWith(branchPrefix)
      ? currentRef.id.slice(branchPrefix.length)
      : currentRef?.category === 'commits'
        ? ''
        : requestedBranchName,
    headOid: result.currentRef?.revision ?? null,
    baseRef,
    requestedBaseOid,
    baseOid: result.branch?.baseRef.revision ?? null
  }
}
