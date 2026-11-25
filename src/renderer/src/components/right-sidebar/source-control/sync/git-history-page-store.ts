import { BoundedMap } from '../../../../../../shared/collections/bounded-map'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'

export type GitHistoryPanelState =
  | { status: 'idle' | 'loading'; result?: GitHistoryResult; error?: string }
  | { status: 'refreshing' | 'ready'; result: GitHistoryResult; error?: string }
  | { status: 'error'; result?: GitHistoryResult; error?: string }

export const EMPTY_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'idle' }
export const LOADING_GIT_HISTORY_STATE: GitHistoryPanelState = { status: 'loading' }

/** What a page answered for: null fields are resolved absence (unborn HEAD, no base), never "unknown". */
type GitHistoryPageKey = {
  request: GitHistoryFence
  branchName: string
  headOid: string | null
  /** Resolved base OID of a branch page; null for a plain HEAD page. */
  baseOid: string | null
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
export const gitHistorySlots = new BoundedMap<string, GitHistoryEntry>({
  maxEntries: 256,
  onEvict: (_entry, slotKey) => notifyGitHistorySlot(slotKey)
})
export const latestGitHistoryRequest = new Map<string, { worktreeId: string; id: number }>()
export const mountedHistoryConsumers = new Map<string, number>()
const gitHistoryListeners = new Map<string, Set<() => void>>()

function notifyGitHistorySlot(slotKey: string): void {
  for (const listener of gitHistoryListeners.get(slotKey) ?? []) {
    listener()
  }
}
export const releasedHistorySlots = new Set<string>()
let sweptWorktreeCatalog: ReadonlyMap<string, unknown> | null = null

export function claimGitHistoryCatalogSweep(catalog: ReadonlyMap<string, unknown>): boolean {
  if (sweptWorktreeCatalog === catalog) {
    return false
  }
  sweptWorktreeCatalog = catalog
  return true
}

export function retireGitHistorySlot(slotKey: string): void {
  gitHistorySlots.delete(slotKey)
  latestGitHistoryRequest.delete(slotKey)
  releasedHistorySlots.delete(slotKey)
  notifyGitHistorySlot(slotKey)
}

let gitHistoryRequestSeq = 0

export function nextGitHistoryRequestId(): number {
  gitHistoryRequestSeq += 1
  return gitHistoryRequestSeq
}

export function publishGitHistory(slotKey: string, entry: GitHistoryEntry): void {
  gitHistorySlots.set(slotKey, entry)
  notifyGitHistorySlot(slotKey)
}

export function subscribeGitHistory(slotKey: string, listener: () => void): () => void {
  const listeners = gitHistoryListeners.get(slotKey) ?? new Set<() => void>()
  gitHistoryListeners.set(slotKey, listeners)
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size && gitHistoryListeners.get(slotKey) === listeners) {
      gitHistoryListeners.delete(slotKey)
    }
  }
}

function pageKeyMatches(key: GitHistoryPageKey, fence: GitHistoryFence): boolean {
  if (
    fence.headOid === undefined ||
    key.branchName !== fence.branchName ||
    key.request.baseRef !== fence.baseRef
  ) {
    return false
  }
  if (key.headOid !== fence.headOid) {
    return false
  }
  // A plain HEAD page does not depend on the base OID; a branch page needs the same resolved base.
  return key.baseOid === null
    ? key.request.baseOid === fence.baseOid
    : key.baseOid === fence.baseOid
}

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
  if (
    state.status === 'ready' &&
    key &&
    fence.headOid !== undefined &&
    fence.baseOid !== undefined &&
    key.request.branchName === fence.branchName &&
    key.request.headOid === fence.headOid &&
    key.request.baseRef === fence.baseRef &&
    key.request.baseOid === fence.baseOid
  ) {
    // The current read finished with an incompatible page, so there is nothing left to wait for.
    return { status: 'error' }
  }
  return state.status === 'error'
    ? { status: 'error', error: state.error }
    : LOADING_GIT_HISTORY_STATE
}

export function pageKeyFor(result: GitHistoryResult, request: GitHistoryFence): GitHistoryPageKey {
  const currentRef = result.currentRef
  const branchPrefix = 'refs/heads/'
  return {
    request,
    branchName: currentRef?.id.startsWith(branchPrefix)
      ? currentRef.id.slice(branchPrefix.length)
      : currentRef?.category === 'commits'
        ? ''
        : request.branchName,
    headOid: result.currentRef?.revision ?? null,
    baseOid: result.branch?.baseRef.revision ?? null
  }
}
