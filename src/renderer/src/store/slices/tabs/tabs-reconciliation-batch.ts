import type { AppState } from '../../types'
import { recordDraft, tabBucketDraft, type RecordDraft } from '../../keyed-record-transitions'

type ReconciledRecords = Pick<
  AppState,
  'unifiedTabsByWorktree' | 'groupsByWorktree' | 'activeGroupIdByWorktree' | 'layoutByWorktree'
>

/** Drafts of the workspace records reconciliation rewrites, one entry per reconciled workspace. */
export type ReconciliationDrafts = {
  unifiedTabs: RecordDraft<AppState['unifiedTabsByWorktree'][string]>
  groups: RecordDraft<AppState['groupsByWorktree'][string]>
  // A workspace with no group stores an undefined active group, as the spread it replaced did.
  activeGroups: RecordDraft<AppState['activeGroupIdByWorktree'][string] | undefined>
  layout: RecordDraft<AppState['layoutByWorktree'][string]>
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
    unifiedTabs: tabBucketDraft(state.unifiedTabsByWorktree),
    groups: recordDraft(state.groupsByWorktree),
    activeGroups: recordDraft<string | undefined>(state.activeGroupIdByWorktree),
    layout: recordDraft(state.layoutByWorktree)
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
  return {
    ...(written.has('unifiedTabs') ? { unifiedTabsByWorktree: drafts.unifiedTabs.finish() } : {}),
    ...(written.has('groups') ? { groupsByWorktree: drafts.groups.finish() } : {}),
    ...(written.has('activeGroups')
      ? {
          activeGroupIdByWorktree:
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: undefined entries were stored before too; readers treat them as absent.
            drafts.activeGroups.finish() as AppState['activeGroupIdByWorktree']
        }
      : {}),
    ...(written.has('layout') ? { layoutByWorktree: drafts.layout.finish() } : {})
  }
}
