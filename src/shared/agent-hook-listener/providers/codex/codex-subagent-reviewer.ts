import { record, type JsonRecord } from './codex-rollout-jsonl-format'

/** Codex's `approvals_reviewer`: `user` is a human, `auto_review` is Codex's own review agent. */
export type CodexApprovalsReviewer = 'user' | 'auto_review'

/** Latest reviewer evidence from turn or thread-settings records. */
export function readApprovalsReviewer(records: JsonRecord[]): CodexApprovalsReviewer | undefined {
  let reviewer: CodexApprovalsReviewer | undefined
  for (const recordValue of records) {
    const payload = record(recordValue.payload)
    const candidate =
      recordValue.type === 'turn_context'
        ? payload?.approvals_reviewer
        : recordValue.type === 'event_msg' && payload?.type === 'thread_settings_applied'
          ? record(payload.thread_settings)?.approvals_reviewer
          : undefined
    const value = typeof candidate === 'string' ? candidate : ''
    if (value === 'user' || value === 'auto_review') {
      reviewer = value
    } else if (value === 'guardian_subagent') {
      // Codex still accepts this legacy spelling and normalizes it to auto_review.
      reviewer = 'auto_review'
    }
  }
  return reviewer
}
