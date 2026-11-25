import { z } from 'zod'

// Tolerant fields: a missing or mistyped value reads as null instead of failing the entry.
const text = z.string().nullable().catch(null)
/** Stored as an integer; every other record field is stored as text. */
export const REMOVED_WORK_INT_FIELD = z.number().nullable().catch(null)
const int = REMOVED_WORK_INT_FIELD
// Drops non-string elements and keeps the rest; text that isn't JSON reads as null.
const idList = z
  .preprocess(parseJsonText, z.array(z.unknown()).nullable())
  .transform((items) => items?.filter((item): item is string => typeof item === 'string') ?? null)
  .catch(null)

function parseJsonText(value: unknown): unknown {
  if (typeof value !== 'string') {
    return null
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** Lineage fields kept for each kind of removed orchestration work. */
export const REMOVED_WORK_LINEAGE_FIELDS = {
  task: {
    parentTaskId: text,
    title: text,
    createdByHandle: text,
    createdByPaneKey: text,
    deps: idList,
    status: text,
    createdAt: text
  },
  dispatch: {
    taskId: text,
    retryOfDispatchId: text,
    creatorDispatchId: text,
    creatorHandle: text,
    creatorPaneKey: text,
    creatorOrcaSessionId: text,
    assigneeHandle: text,
    assigneePaneKey: text,
    assigneeOrcaSessionId: text,
    hostScope: text,
    depth: int,
    status: text,
    // Null when no exit was ever recorded; an exit Orca could not certify is saved as 'unknown'.
    terminationReason: text,
    createdAt: text
  },
  worker: { state: text, stage: text, worktreeId: text, terminalHandle: text, createdAt: text },
  terminal: {
    originDispatchId: text,
    ownerDispatchId: text,
    priorOwnerDispatchIds: idList,
    terminalHandle: text,
    paneKey: text,
    worktreeId: text,
    hostScope: text,
    ownershipState: text,
    releaseState: text,
    createdAt: text
  },
  remote_worker: {
    taskId: text,
    homePeerFingerprint: text,
    state: text,
    stage: text,
    worktreeId: text,
    terminalHandle: text,
    paneKey: text,
    depth: int,
    createdAt: text
  },
  federated_worker: {
    environmentId: text,
    environmentName: text,
    remoteWorktreeId: text,
    remoteTerminalHandle: text,
    dispatchStatus: text,
    createdAt: text
  }
}

export type RemovedWorkKind = keyof typeof REMOVED_WORK_LINEAGE_FIELDS

const entryBase = { seq: z.number(), id: z.string(), removedAt: z.string() }
const workerBase = { ...entryBase, activeAtRemoval: z.boolean() }
const lineage = REMOVED_WORK_LINEAGE_FIELDS

/** One listed entry: the stored record checked against its kind's fields. */
export const RemovedWorkEntrySchema = z.discriminatedUnion('kind', [
  z.object({ ...entryBase, kind: z.literal('task'), ...lineage.task }),
  z.object({ ...entryBase, kind: z.literal('dispatch'), ...lineage.dispatch }),
  z.object({ ...workerBase, kind: z.literal('worker'), ...lineage.worker }),
  z.object({ ...entryBase, kind: z.literal('terminal'), ...lineage.terminal }),
  z.object({ ...workerBase, kind: z.literal('remote_worker'), ...lineage.remote_worker }),
  z.object({ ...workerBase, kind: z.literal('federated_worker'), ...lineage.federated_worker })
])

type RemovedWorkEntryBase = { seq: number; id: string; removedAt: string }
export type RemovedWorkEntry =
  | z.infer<typeof RemovedWorkEntrySchema>
  | (RemovedWorkEntryBase & { kind: string; unreadable: true })

/** `orchestration.runShow` result `removedWork`: constant size unless entries were requested. */
export type RunRemovedWork = {
  // 'partial': the Run predates recordedSince, so earlier removals were not recorded.
  coverage: 'complete' | 'partial'
  recordedSince: string
  tasks: number
  dispatches: number
  workers: number
  terminals: number
  activeWorkersAtRemoval: number
  lastRemovedAt: string | null
  entries?: RemovedWorkEntry[]
  page?: { hasMore: boolean; nextCursor: string | null }
}

/** `orchestration.reset --tasks` result `removed`: what this reset removed, across every Run. */
export type ResetRemovedWork = {
  runs: number
  // Absent from hosts that predate it.
  runIds?: string[]
  tasks: number
  dispatches: number
  workers: number
  possiblyRunning: number
}

export const REMOVED_WORK_PAGE_SIZE = 200
