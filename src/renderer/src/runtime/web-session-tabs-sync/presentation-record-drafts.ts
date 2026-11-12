import { recordDraft, type RecordDraft } from '@/store/keyed-record-transitions'
import type { WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'

export type PresentationRecordKey =
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'runtimePaneTitlesByTabId'
type PresentationValue<K extends PresentationRecordKey> = NonNullable<
  WebSessionTabsSyncState[K]
>[string]
type PresentationRecords = {
  [K in PresentationRecordKey]: Record<string, PresentationValue<K>>
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
  const draft = recordDraft<PresentationValue<K>>(records[key] ?? {})
  if (batch) {
    batch.presentationDrafts ??= {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the generic key and value share K; the indexed mapped type cannot retain that relation on assignment.
    const drafts = batch.presentationDrafts as Partial<Record<K, RecordDraft<PresentationValue<K>>>>
    drafts[key] = draft
  }
  return draft
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
  for (const key of [
    'ptyIdsByTabId',
    'terminalLayoutsByTabId',
    'runtimePaneTitlesByTabId'
  ] as const) {
    const draft = drafts[key]
    if (draft && batch.changedRecords.has(key)) {
      Object.assign(patch, { [key]: draft.finish() })
    }
  }
}
