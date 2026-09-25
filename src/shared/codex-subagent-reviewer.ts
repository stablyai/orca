import { extname, isAbsolute } from 'node:path'

import { readJsonlCursor, type JsonRecord } from './codex-rollout-jsonl-cursor'
import type { CodexSubagentTranscriptState } from './codex-subagent-transcript'

const REVIEWER_CURSOR_MAX_PATHS = 64

/** Codex's `approvals_reviewer`: `user` is a human, `auto_review` is Codex's own review agent. */
export type CodexApprovalsReviewer = 'user' | 'auto_review'

function normalizedTranscriptPath(transcriptPath: string | undefined): string | undefined {
  const normalizedPath = transcriptPath?.trim()
  return normalizedPath && isAbsolute(normalizedPath) && extname(normalizedPath) === '.jsonl'
    ? normalizedPath
    : undefined
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

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

/** Whether the transcript's own review agent resolves this permission request. */
export function codexTurnApprovalsAreAutoReviewed(
  state: CodexSubagentTranscriptState | undefined,
  transcriptPath?: string
): boolean {
  const normalizedPath = normalizedTranscriptPath(transcriptPath)
  if (!state || !normalizedPath) {
    return false
  }
  const reviewer =
    normalizedPath === state.parent.filePath
      ? state.approvalsReviewer
      : state.reviewersByPath.get(normalizedPath)
  return reviewer === 'auto_review'
}

/** Reads reviewer ownership from a child rollout without replacing the parent lifecycle cursor. */
export function reconcileCodexSubagentReviewer(
  state: CodexSubagentTranscriptState,
  transcriptPath: string | undefined
): void {
  const normalizedPath = normalizedTranscriptPath(transcriptPath)
  if (!normalizedPath) {
    return
  }
  let cursor = state.reviewerCursorsByPath.get(normalizedPath)
  if (!cursor) {
    if (state.reviewerCursorsByPath.size >= REVIEWER_CURSOR_MAX_PATHS) {
      const oldestPath = state.reviewerCursorsByPath.keys().next().value
      if (typeof oldestPath === 'string') {
        state.reviewerCursorsByPath.delete(oldestPath)
        state.reviewersByPath.delete(oldestPath)
      }
    }
    cursor = { filePath: normalizedPath, offset: 0, carry: '' }
    state.reviewerCursorsByPath.set(normalizedPath, cursor)
  }
  const records = readJsonlCursor(cursor)
  if (records === undefined) {
    state.reviewerCursorsByPath.delete(normalizedPath)
    state.reviewersByPath.delete(normalizedPath)
    return
  }
  const reviewer = readApprovalsReviewer(records)
  if (reviewer !== undefined) {
    state.reviewersByPath.set(normalizedPath, reviewer)
  }
}
