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
  /** 'deferred' leaves the parent cursor unchanged until the next poll. */
  parentBytes: JsonlCursorBytes | undefined | 'deferred'
  childBytes: Map<
    TrackedTranscriptSubagent,
    { filePath: string | undefined; bytes: JsonlCursorBytes | undefined }
  >
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
  const entriesByDirectory = new Map<string, string[] | undefined>()
  // oxlint-disable-next-line unicorn/no-useless-spread -- the loop awaits; hooks may add or remove children meanwhile.
  for (const [id, tracked] of [...state.subagents]) {
    // A replaced session or pane makes the rest of this batch unappliable; stop opening its rollouts.
    if (!wanted()) {
      return
    }
    if (state.subagents.get(id) !== tracked) {
      continue
    }
    if (!tracked.filePath) {
      // Hook prefetches leave path discovery to the poll, so a timed-out hook queues no directory reads.
      if (!resolvePaths) {
        continue
      }
      const directories = childTranscriptDirectories(parentPath, tracked.startedAt)
      for (const directory of directories) {
        if (!entriesByDirectory.has(directory)) {
          const entries = await readTranscriptDirectoryAsync(directory, batch)
          entriesByDirectory.set(directory, batch.deferrals.has(directory) ? undefined : entries)
        }
      }
      if (!wanted()) {
        return
      }
      if (state.subagents.get(id) !== tracked) {
        continue
      }
      tracked.filePath ??= resolveChildTranscript(parentPath, id, tracked.startedAt, (directory) =>
        entriesByDirectory.get(directory)
      )
      if (
        !tracked.filePath &&
        directories.some((directory) => !entriesByDirectory.get(directory))
      ) {
        continue
      }
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
      const filePath = cursor.filePath
      const bytes = await readJsonlCursorBytes(cursor, batch)
      if (!child) {
        reads.parentBytes = bytes
      } else if (bytes !== 'deferred' && child.filePath === filePath) {
        reads.childBytes.set(child, { filePath, bytes })
      }
      return (
        bytes !== 'deferred' ||
        (filePath !== undefined && batch.deferrals.get(filePath) === 'resource')
      )
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
  if (
    state.parent !== reads.parent ||
    (reads.parentBytes === 'deferred' && reads.childBytes.size === 0)
  ) {
    return false
  }
  let changed = false
  if (reads.parentBytes !== 'deferred') {
    const parentRecords = applyJsonlCursorBytes(
      reads.parent,
      reads.parentBytes,
      isCodexStatusTranscriptLine
    )
    if (parentRecords === 'stale') {
      return false
    }
    changed = applyCodexParentTranscript(state, roster, parentRecords)
  }
  return (
    applyCodexChildTranscripts(state, roster, (_id, tracked) => {
      const read = reads.childBytes.get(tracked)
      if (!read || read.filePath !== tracked.filePath) {
        return 'deferred'
      }
      const records = applyJsonlCursorBytes(tracked, read.bytes, isCodexStatusTranscriptLine)
      return records === 'stale' ? 'deferred' : records
    }) || changed
  )
}
