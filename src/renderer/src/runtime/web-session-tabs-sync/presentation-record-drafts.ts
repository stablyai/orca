import { recordDraft, tabBucketDraft, type RecordDraft } from '@/store/keyed-record-transitions'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'

const SEAM_PRESENTATION_FIELDS = [
  'ptyIdsByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'tabsByWorktree',
  'unifiedTabsByWorktree'
] as const
export type PresentationRecordKey = (typeof SEAM_PRESENTATION_FIELDS)[number]
type PresentationValue<K extends PresentationRecordKey> = NonNullable<
  WebSessionTabsSyncState[K]
>[string]
type PresentationRecords = {
  [K in PresentationRecordKey]: Record<string, PresentationValue<K>>
}
const draftFactories: {
  [K in PresentationRecordKey]: (
    source: Readonly<Record<string, PresentationValue<K>>>
  ) => RecordDraft<PresentationValue<K>>
} = {
  ptyIdsByTabId: recordDraft,
  terminalLayoutsByTabId: recordDraft,
  runtimePaneTitlesByTabId: recordDraft,
  tabsByWorktree: tabBucketDraft,
  unifiedTabsByWorktree: tabBucketDraft
}
export type PresentationRecordDrafts = Partial<{
  [K in PresentationRecordKey]: RecordDraft<PresentationValue<K>>
}>

export function presentationRecordDraft<K extends PresentationRecordKey>(
  state: WebSessionTabsSyncState,
  key: K,
  batch?: WebSessionTabsBatchContext
): RecordDraft<PresentationValue<K>> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each cache key stores only the draft for that same presentation record.
  const cached = batch?.presentationDrafts?.[key] as RecordDraft<PresentationValue<K>> | undefined
  if (cached) {
    return cached
  }
  const records: Partial<PresentationRecords> = state
  const draft = draftFactories[key](records[key] ?? {})
  if (batch) {
    batch.presentationDrafts ??= {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generic key and value share K; the indexed mapped type cannot retain that relation on assignment.
    const drafts = batch.presentationDrafts as Partial<Record<K, RecordDraft<PresentationValue<K>>>>
    drafts[key] = draft
  }
  return draft
}

export function withWorktreeTabEntry<K extends 'tabsByWorktree' | 'unifiedTabsByWorktree'>(
  state: WebSessionTabsSyncState,
  key: K,
  worktreeId: string,
  value: PresentationValue<K> | null,
  equal: (previous: PresentationValue<K> | undefined, next: PresentationValue<K> | null) => boolean,
  batch?: WebSessionTabsBatchContext
): Record<string, PresentationValue<K>> {
  const records: Partial<PresentationRecords> = state
  const source = records[key] ?? {}
  if (equal(source[worktreeId], value)) {
    return source
  }
  const draft = presentationRecordDraft(state, key, batch)
  if (value === null) {
    draft.delete(worktreeId)
  } else {
    draft.set(worktreeId, value)
  }
  return finishPresentationRecord(state, key, draft, batch)
}

export function finishPresentationRecord<K extends PresentationRecordKey>(
  state: WebSessionTabsSyncState,
  key: K,
  draft: RecordDraft<PresentationValue<K>>,
  batch?: WebSessionTabsBatchContext
): Record<string, PresentationValue<K>> {
  const next = batch ? draft.view() : draft.finish()
  if (batch && next !== state[key]) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: next was built from this exact record key and preserves its value type.
    const writable: Partial<PresentationRecords> = state
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the draft is for K and therefore contains precisely this record's value type.
    writable[key] = next as PresentationRecords[K]
    batch.changedRecords.add(key)
  }
  return next
}

export function publishPresentationRecords(
  batch: WebSessionTabsBatchContext,
  patch: Partial<WebSessionTabsSyncState>
): void {
  const drafts = batch.presentationDrafts
  if (!drafts) {
    return
  }
  for (const key of SEAM_PRESENTATION_FIELDS) {
    const draft = drafts[key]
    if (draft && batch.changedRecords.has(key)) {
      Object.assign(patch, { [key]: draft.finish() })
    }
  }
}
