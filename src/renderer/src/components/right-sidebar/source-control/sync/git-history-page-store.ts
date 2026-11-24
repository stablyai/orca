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

// Listeners per slot, so one section's read never wakes the hooks of unrelated retained sections.
const gitHistoryListeners = new Map<string, Set<() => void>>()

function notifyGitHistorySlot(slotKey: string): void {
  for (const listener of gitHistoryListeners.get(slotKey) ?? []) {
    listener()
  }
}

const MAX_GIT_HISTORY_SLOTS = 256
// Share each worktree and execution owner’s history across panel remounts.
export const gitHistorySlots = new BoundedMap<string, GitHistoryEntry>({
  maxEntries: MAX_GIT_HISTORY_SLOTS,
  // Reached only with more read slots than the cap (see publishGitHistory); never keep a dropped page.
  onEvict: (_entry, slotKey) => notifyGitHistorySlot(slotKey)
})
export const latestGitHistoryRequest = new Map<string, { worktreeId: string; id: number }>()
export const mountedHistoryConsumers = new Map<string, number>()
/** Slots no consumer has held since the last sweep; a workspace switch checks only these. */
export const releasedHistorySlots = new Set<string>()
// The worktree catalog the last sweep checked, shared so a remount with the same catalog does not sweep again.
let sweptWorktreeCatalog: ReadonlyMap<string, unknown> | null = null

/** Slots that may have lost their worktree: every request after a catalog change, else only released slots. */
export function takeRetirementCandidates(catalog: ReadonlyMap<string, unknown>): string[] {
  const candidates =
    sweptWorktreeCatalog === catalog
      ? [...releasedHistorySlots]
      : [...latestGitHistoryRequest.keys()]
  sweptWorktreeCatalog = catalog
  releasedHistorySlots.clear()
  return candidates
}
let gitHistoryRequestSeq = 0

export function nextGitHistoryRequestId(): number {
  gitHistoryRequestSeq += 1
  return gitHistoryRequestSeq
}

export function publishGitHistory(slotKey: string, entry: GitHistoryEntry): void {
  if (!gitHistorySlots.has(slotKey) && gitHistorySlots.size >= MAX_GIT_HISTORY_SLOTS) {
    // About to evict: mark pages that sections still read as recent, so an unread page goes first.
    for (const readSlotKey of gitHistoryListeners.keys()) {
      gitHistorySlots.get(readSlotKey)
    }
  }
  gitHistorySlots.set(slotKey, entry)
  notifyGitHistorySlot(slotKey)
}

/** Drops a slot's page and pending request, then tells that slot's readers. */
export function retireGitHistorySlot(slotKey: string): void {
  gitHistorySlots.delete(slotKey)
  latestGitHistoryRequest.delete(slotKey)
  releasedHistorySlots.delete(slotKey)
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
