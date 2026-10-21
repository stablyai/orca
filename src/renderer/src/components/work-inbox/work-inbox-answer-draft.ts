import type { WorkInboxAnswerParams, WorkInboxItem } from '../../../../shared/work-inbox'

export type WorkInboxDraftFailure = 'conflict' | 'not-found' | 'unreachable'

export type WorkInboxDraft = {
  optionId: string | null
  text: string
  /** Frozen payload of a send whose outcome is unknown; Retry resends it byte-for-byte so the
   *  host dedupes it, and the draft stays locked until the host confirms or refuses it. */
  pending: Readonly<WorkInboxAnswerParams> | null
  submitting: boolean
  failure: WorkInboxDraftFailure | null
}

export const EMPTY_WORK_INBOX_DRAFT: WorkInboxDraft = {
  optionId: null,
  text: '',
  pending: null,
  submitting: false,
  failure: null
}

export function workInboxDraftKey(targetKey: string, itemId: string): string {
  return `${targetKey}\n${itemId}`
}

/** Refused while a send is unresolved: the first answer may already be saved on the host. */
export function editWorkInboxDraft(
  draft: WorkInboxDraft,
  patch: Partial<Pick<WorkInboxDraft, 'optionId' | 'text'>>
): WorkInboxDraft {
  if (draft.pending || draft.submitting) {
    return draft
  }
  return { ...draft, ...patch, failure: null }
}

export function isWorkInboxDraftLocked(draft: WorkInboxDraft): boolean {
  return draft.pending !== null || draft.submitting
}

export function canSubmitWorkInboxDraft(item: WorkInboxItem, draft: WorkInboxDraft): boolean {
  if (item.status !== 'open' || draft.submitting) {
    return false
  }
  if (draft.pending) {
    return draft.pending.id === item.id
  }
  const hasOption = draft.optionId !== null && item.options.some((o) => o.id === draft.optionId)
  const hasText = item.allowFreeText && draft.text.trim().length > 0
  return hasOption || hasText
}

export function buildWorkInboxAnswer(
  item: WorkInboxItem,
  draft: WorkInboxDraft,
  createRequestId: () => string
): Readonly<WorkInboxAnswerParams> {
  if (draft.pending) {
    return draft.pending
  }
  const text = item.allowFreeText ? draft.text.trim() : ''
  return Object.freeze({
    id: item.id,
    expectedRevision: item.revision,
    clientRequestId: createRequestId(),
    ...(draft.optionId !== null ? { optionId: draft.optionId } : {}),
    ...(text ? { text } : {})
  })
}

/** Keeps the newer copy of each item so a list fetched before an answer can't roll it back. */
export function mergeWorkInboxItems(
  previous: readonly WorkInboxItem[],
  next: readonly WorkInboxItem[]
): WorkInboxItem[] {
  const known = new Map(previous.map((item) => [item.id, item]))
  return next.map((item) => {
    const prior = known.get(item.id)
    return prior && prior.revision > item.revision ? prior : item
  })
}
