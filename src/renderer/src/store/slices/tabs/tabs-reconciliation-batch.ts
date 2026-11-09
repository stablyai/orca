import type { AppState } from '../../types'
import { recordDraft, tabBucketDraft, type RecordDraft } from '../../keyed-record-transitions'

type ReconciledRecords = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
>

/** The workspace records reconciliation rewrites, one entry per reconciled workspace. */
export type ReconciliationDrafts = {
  unifiedTabsByWorktree: RecordDraft<AppState['unifiedTabsByWorktree'][string]>
  groupsByWorktree: RecordDraft<AppState['groupsByWorktree'][string]>
  // A workspace with no group stores an undefined active group, as the spread it replaced did.
  activeGroupIdByWorktree: RecordDraft<AppState['activeGroupIdByWorktree'][string] | undefined>
  layoutByWorktree: RecordDraft<AppState['layoutByWorktree'][string]>
}

export type ReconciliationDraftField = keyof ReconciliationDrafts

/** One multi-workspace fold clones each shared map once and indexes read-only openFiles once, avoiding repeated map spreads and file scans per workspace. */
export type WorktreeTabModelReconciliationBatch = {
  /** Top-level `AppState` keys this fold already cloned and therefore owns. */
  readonly ownedStateKeys: Set<string>
  readonly liveEditorIds: ReadonlySet<string>
  /** Held across the fold and finished once before the merged patch publishes. */
  readonly drafts: ReconciliationDrafts
  /** Draft fields some workspace's patch wrote, so the merged patch carries them. */
  readonly writtenDraftFields: Set<ReconciliationDraftField>
}

export function createReconciliationDrafts(state: ReconciledRecords): ReconciliationDrafts {
  return {
    unifiedTabsByWorktree: tabBucketDraft(state.unifiedTabsByWorktree),
    groupsByWorktree: recordDraft(state.groupsByWorktree),
    activeGroupIdByWorktree: recordDraft<string | undefined>(state.activeGroupIdByWorktree),
    layoutByWorktree: recordDraft(state.layoutByWorktree)
  }
}

export function createWorktreeTabModelReconciliationBatch(
  state: Pick<AppState, 'openFiles'> & ReconciledRecords
): WorktreeTabModelReconciliationBatch {
  return {
    ownedStateKeys: new Set<string>(),
    liveEditorIds: new Set(state.openFiles.map((file) => file.id)),
    drafts: createReconciliationDrafts(state),
    writtenDraftFields: new Set()
  }
}

/** Finishes the written drafts; each becomes one published record. */
export function finishReconciliationDrafts(
  drafts: ReconciliationDrafts,
  written: ReadonlySet<ReconciliationDraftField>
): Partial<ReconciledRecords> {
  const patch: Partial<Record<ReconciliationDraftField, unknown>> = {}
  for (const field of written) {
    patch[field] = drafts[field].finish()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each field holds its own draft's finished record; undefined active groups were stored before too.
  return patch as Partial<ReconciledRecords>
}
