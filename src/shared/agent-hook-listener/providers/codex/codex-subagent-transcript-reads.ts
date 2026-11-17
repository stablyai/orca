import {
  readJsonlCursorBytes,
  readTranscriptDirectoryAsync,
  type RolloutReadBatch
} from './codex-rollout-async-reads'
import {
  applyJsonlCursorBytes,
  type JsonlCursor,
  type JsonlCursorBytes
} from './codex-rollout-jsonl-format'
import { prefetchJsonlCursor, type PrefetchedRolloutReads } from './codex-rollout-prefetch-scope'
import { childTranscriptDirectories, resolveChildTranscript } from './codex-rollout-paths'
import { isCodexStatusTranscriptLine } from './codex-status-transcript-line'
import type { CodexSubagentRoster } from './codex-subagent-roster'
import {
  applyCodexChildTranscripts,
  applyCodexParentTranscript,
  type CodexSubagentTranscriptState,
  type TrackedTranscriptSubagent
} from './codex-subagent-transcript'

/** New rollout bytes read off the main thread; nothing in the transcript state moves until they are applied. */
export type CodexSubagentTranscriptReads = {
  parent: JsonlCursor
  /** 'deferred' when the read budget was full; the whole batch then waits for the next poll. */
  parentBytes: JsonlCursorBytes | undefined | 'deferred'
  childBytes: Map<TrackedTranscriptSubagent, JsonlCursorBytes | undefined>
}

/** Visits the parent cursor, then each child's after resolving its rollout path asynchronously, one at a time. */
async function visitCodexTranscriptCursors(
  state: CodexSubagentTranscriptState,
  visit: (cursor: JsonlCursor, child?: TrackedTranscriptSubagent) => Promise<boolean>,
  batch: RolloutReadBatch,
  resolvePaths: boolean
): Promise<void> {
  const parent = state.parent
  const parentPath = parent.filePath
  const wanted = (): boolean => state.parent === parent && batch.wanted()
  // A visit returns false to stop the batch (budget full); the rest waits for the next poll.
  if (!(await visit(parent)) || !parentPath) {
    return
  }
  const entriesByDirectory = new Map<string, string[]>()
  // oxlint-disable-next-line unicorn/no-useless-spread -- the loop awaits; hooks may add or remove children meanwhile.
  for (const [id, tracked] of [...state.subagents]) {
    // A replaced session or pane makes the rest of this batch unappliable; stop opening its rollouts.
    if (!wanted() || state.subagents.get(id) !== tracked) {
      return
    }
    if (!tracked.filePath) {
      // Hook prefetches leave path discovery to the poll, so a timed-out hook queues no directory reads.
      if (!resolvePaths) {
        continue
      }
      for (const directory of childTranscriptDirectories(parentPath, tracked.startedAt)) {
        if (!entriesByDirectory.has(directory)) {
          entriesByDirectory.set(directory, await readTranscriptDirectoryAsync(directory, batch))
        }
      }
      if (!wanted()) {
        return
      }
      tracked.filePath ??= resolveChildTranscript(parentPath, id, tracked.startedAt, (directory) =>
        entriesByDirectory.get(directory)
      )
    }
    if (!(await visit(tracked, tracked))) {
      return
    }
  }
}

export async function readCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  batch: RolloutReadBatch
): Promise<CodexSubagentTranscriptReads> {
  const reads: CodexSubagentTranscriptReads = {
    parent: state.parent,
    parentBytes: undefined,
    childBytes: new Map()
  }
  await visitCodexTranscriptCursors(
    state,
    async (cursor, child) => {
      const bytes = await readJsonlCursorBytes(cursor, batch)
      if (!child) {
        reads.parentBytes = bytes
      } else if (bytes !== 'deferred') {
        reads.childBytes.set(child, bytes)
      }
      return bytes !== 'deferred'
    },
    batch,
    true
  )
  return reads
}

export function prefetchCodexSubagentTranscript(
  state: CodexSubagentTranscriptState,
  reads: PrefetchedRolloutReads
): Promise<void> {
  return visitCodexTranscriptCursors(
    state,
    async (cursor) => {
      await prefetchJsonlCursor(reads, cursor)
      return true
    },
    reads.batch,
    false
  )
}

/** Applies reads in one synchronous step; cursors a hook-driven read moved meanwhile are re-read next poll. Children found by these reads are read next poll. */
export function applyCodexSubagentTranscriptReads(
  state: CodexSubagentTranscriptState,
  roster: CodexSubagentRoster,
  reads: CodexSubagentTranscriptReads
): boolean {
  if (state.parent !== reads.parent || reads.parentBytes === 'deferred') {
    return false
  }
  const parentRecords = applyJsonlCursorBytes(
    reads.parent,
    reads.parentBytes,
    isCodexStatusTranscriptLine
  )
  if (parentRecords === 'stale') {
    return false
  }
  const changed = applyCodexParentTranscript(state, roster, parentRecords)
  return (
    applyCodexChildTranscripts(state, roster, (_id, tracked) => {
      if (!reads.childBytes.has(tracked)) {
        return 'deferred'
      }
      const records = applyJsonlCursorBytes(
        tracked,
        reads.childBytes.get(tracked),
        isCodexStatusTranscriptLine
      )
      return records === 'stale' ? 'deferred' : records
    }) || changed
  )
}
