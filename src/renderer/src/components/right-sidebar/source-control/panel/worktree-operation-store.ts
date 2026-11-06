import { createStore, type StoreApi } from 'zustand/vanilla'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  clearSessionCommitDraftForWorktree,
  loadSessionCommitDrafts,
  saveSessionCommitDrafts
} from '@/lib/source-control-commit-draft-session'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { GitConflictOperation } from '../../../../../../shared/git/status/git-status-types'
import type { SourceControlActionError } from '../sync/action-error'
import type { CreatePrIntentNotice } from '../commit/commit-area-types'
import {
  createPrIntentCurrentTargetConflictsWithToken,
  type CreatePrIntentCurrentTarget,
  type CreatePrIntentRunToken
} from '../review/create-pr-intent-flow'

/** Everything Source Control tracks for one worktree copy; lives past panel/section unmounts. */
export type WorktreeOperationRecord = {
  readonly draftKey: string
  draft: string
  commitError: string | null
  isCommitting: boolean
  isAbortingOperation: boolean
  remoteActionError: SourceControlActionError | null
  remoteActionSequence: number
  generateInFlight: boolean
  generateError: string | null
  isCreatingPr: boolean
  /** The run that owns this copy's Create PR intent; null when idle or invalidated. */
  createPrIntentRun: CreatePrIntentRunToken | null
  createPrIntentNotice: CreatePrIntentNotice | null
  createPrIntentTarget: CreatePrIntentCurrentTarget
  observedConflictOperation: GitConflictOperation
}

export type WorktreeOperationStore = StoreApi<WorktreeOperationRecord>

type Entry = {
  store: WorktreeOperationStore
  worktreeId: string
  hostId: ExecutionHostId | null
  instanceId: string | undefined
}

const entries = new Map<string, Entry>()
const retiredStores = new WeakSet<WorktreeOperationStore>()
let retiringSubscribed = false

function isLocalHost(hostId: ExecutionHostId | null): boolean {
  return hostId === null || hostId === LOCAL_EXECUTION_HOST_ID
}

// Local copies keep the bare-id draft key so teardown's legacy clear still finds them.
function commitDraftKey(worktreeId: string, hostId: ExecutionHostId | null): string {
  return isLocalHost(hostId) ? worktreeId : `${hostId}::${worktreeId}`
}

function createRecord(draftKey: string): WorktreeOperationRecord {
  return {
    draftKey,
    draft: loadSessionCommitDrafts()[draftKey] ?? '',
    commitError: null,
    isCommitting: false,
    isAbortingOperation: false,
    remoteActionError: null,
    remoteActionSequence: 0,
    generateInFlight: false,
    generateError: null,
    isCreatingPr: false,
    createPrIntentRun: null,
    createPrIntentNotice: null,
    createPrIntentTarget: {},
    observedConflictOperation: 'unknown'
  }
}

// Inert record for a panel with no worktree; consumers refuse to act without one.
const UNOWNED_STORE: WorktreeOperationStore = createStore(() => createRecord(''))

function retire(key: string, entry: Entry): void {
  entries.delete(key)
  retiredStores.add(entry.store)
  // A late finally on the detached store can no longer claim the run or resurrect the draft.
  entry.store.setState({ createPrIntentRun: null })
  clearSessionCommitDraftForWorktree(entry.store.getState().draftKey)
}

function entryStillExists(entry: Entry, worktreesByRepo: AppState['worktreesByRepo']) {
  return getIndexedWorktreesById(worktreesByRepo, entry.worktreeId).some(
    (row) =>
      // Why unstamped rows match any host: discovery backfills hostId after the row first lands.
      (entry.hostId === null || row.hostId === undefined || row.hostId === entry.hostId) &&
      (entry.instanceId === undefined || row.instanceId === entry.instanceId)
  )
}

function subscribeRetirement(): void {
  retiringSubscribed = true
  useAppStore.subscribe((state, previous) => {
    const worktreesByRepo = selectWorktreesByRepo(state)
    if (worktreesByRepo === selectWorktreesByRepo(previous)) {
      return
    }
    for (const [key, entry] of entries) {
      if (!entryStillExists(entry, worktreesByRepo)) {
        retire(key, entry)
      }
    }
  })
}

/** One store per host/worktree/instance; a reused id with a new instance never inherits state. */
export function getWorktreeOperationStore(
  worktreeId: string | null,
  hostId: ExecutionHostId | null,
  instanceId: string | undefined
): WorktreeOperationStore {
  if (!worktreeId) {
    return UNOWNED_STORE
  }
  if (!retiringSubscribed) {
    subscribeRetirement()
  }
  const key = `${hostId ?? LOCAL_EXECUTION_HOST_ID}::${worktreeId}`
  const existing = entries.get(key)
  if (existing) {
    if (!instanceId || !existing.instanceId || existing.instanceId === instanceId) {
      // Why adopt: rows hydrate their instance id after the first render.
      existing.instanceId ??= instanceId
      return existing.store
    }
    retire(key, existing)
  }
  const store = createStore<WorktreeOperationRecord>(() =>
    createRecord(commitDraftKey(worktreeId, hostId))
  )
  entries.set(key, { store, worktreeId, hostId, instanceId })
  return store
}

/** Draft writes update the session cache at the boundary so remounts read the latest text. */
export function writeWorktreeCommitDraft(
  store: WorktreeOperationStore,
  update: string | ((draft: string) => string)
): void {
  const { draft, draftKey } = store.getState()
  const next = typeof update === 'function' ? update(draft) : update
  if (next === draft) {
    return
  }
  store.setState({ draft: next })
  if (store !== UNOWNED_STORE && !retiredStores.has(store)) {
    saveSessionCommitDrafts({ ...loadSessionCommitDrafts(), [draftKey]: next })
  }
}

export function setCreatePrIntentNotice(
  store: WorktreeOperationStore,
  notice: CreatePrIntentNotice | null
): void {
  store.setState({ createPrIntentNotice: notice })
}

/** The run still owns the copy and the user has not moved its branch or base underneath it. */
export function createPrIntentRunIsCurrent(
  store: WorktreeOperationStore,
  token: CreatePrIntentRunToken
): boolean {
  const { createPrIntentRun, createPrIntentTarget } = store.getState()
  return (
    createPrIntentRun === token &&
    !createPrIntentCurrentTargetConflictsWithToken(token, createPrIntentTarget)
  )
}
