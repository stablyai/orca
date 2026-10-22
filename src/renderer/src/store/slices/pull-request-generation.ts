import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { resolveGeneratedFields } from './pull-request-generation-auto-submit'
import type {
  PullRequestFieldRevisions,
  PullRequestGenerationContext,
  PullRequestGenerationFields,
  PullRequestGenerationRecord,
  PullRequestGenerationRecords,
  PullRequestGenerationSlice
} from './pull-request-generation-state'
export type * from './pull-request-generation-state'

export function getPullRequestGenerationWorktreeKey(
  worktreeId: string | null | undefined,
  worktreePath: string | null | undefined
): string | null {
  if (worktreeId) {
    return worktreeId
  }
  return worktreePath?.trim() ? worktreePath : null
}

export function getPullRequestGenerationRecordKey({
  worktreeId,
  worktreePath,
  repoId,
  branch
}: {
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  repoId: string | null | undefined
  branch: string | null | undefined
}): string | null {
  const worktreeKey = getPullRequestGenerationWorktreeKey(worktreeId, worktreePath)
  if (!worktreeKey || !repoId || !branch) {
    return null
  }
  return JSON.stringify([repoId, worktreeKey, branch])
}

export function arePullRequestGenerationFieldsEqual(
  left: PullRequestGenerationFields,
  right: PullRequestGenerationFields
): boolean {
  return (
    left.base === right.base &&
    left.title === right.title &&
    left.body === right.body &&
    left.draft === right.draft
  )
}

export function shouldApplyPullRequestGenerationResult({
  record,
  requestId
}: {
  record: PullRequestGenerationRecord | null | undefined
  requestId: number
}): boolean {
  return record?.context.requestId === requestId && record.status === 'running'
}

export function shouldHydratePullRequestGenerationResult({
  record
}: {
  record: PullRequestGenerationRecord | null | undefined
}): boolean {
  return record?.status === 'succeeded' && record.result !== null && !record.hydrated
}

export function getPullRequestGenerationSeedRestoreKey({
  recordKey,
  record
}: {
  recordKey: string | null | undefined
  record: PullRequestGenerationRecord | null | undefined
}): string | null {
  if (!recordKey || !record) {
    return null
  }
  const shouldRestoreRunningSeed = record.status === 'running'
  const shouldRestoreTerminalSeed =
    !record.hydrated &&
    (record.status === 'succeeded' || record.status === 'failed' || record.status === 'canceled')
  if (!shouldRestoreRunningSeed && !shouldRestoreTerminalSeed) {
    return null
  }
  return `${recordKey}:${record.context.requestId}:${record.status}`
}

export function createRunningPullRequestGenerationRecord(
  context: PullRequestGenerationContext,
  seed: PullRequestGenerationFields,
  seedFieldRevisions: PullRequestFieldRevisions,
  autoSubmit = false
): PullRequestGenerationRecord {
  return {
    context,
    seed,
    seedFieldRevisions,
    requiresPushBeforeCreate: false,
    status: 'running',
    result: null,
    error: null,
    hydrated: false,
    autoSubmit
  }
}

export function recordPullRequestGenerationEdits(
  record: PullRequestGenerationRecord | null,
  fields: PullRequestGenerationFields,
  revisions: PullRequestFieldRevisions
): PullRequestGenerationRecord | null {
  if (!record || record.status !== 'running' || !record.autoSubmit) {
    return null
  }
  const edited = record.editedFields ?? {
    fields: record.seed,
    revisions: record.seedFieldRevisions
  }
  const next = { fields: { ...edited.fields }, revisions: { ...edited.revisions } }
  let changed = false
  for (const field of ['base', 'title', 'body', 'draft'] as const) {
    if (revisions[field] <= next.revisions[field]) {
      continue
    }
    if (field === 'draft') {
      next.fields.draft = fields.draft
    } else {
      next.fields[field] = fields[field]
    }
    next.revisions[field] = revisions[field]
    changed = true
  }
  return changed ? { ...record, editedFields: next } : null
}

export function resolvePullRequestGenerationSuccess({
  record,
  requestId,
  result
}: {
  record: PullRequestGenerationRecord | null | undefined
  requestId: number
  result: PullRequestGenerationFields
}): PullRequestGenerationRecord | null {
  if (!record || record.context.requestId !== requestId || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    status: 'succeeded',
    result: resolveGeneratedFields(record, result),
    error: null,
    hydrated: false
  }
}

export function resolvePullRequestGenerationFailure({
  record,
  requestId,
  error,
  canceled = false
}: {
  record: PullRequestGenerationRecord | null | undefined
  requestId: number
  error: string | null
  canceled?: boolean
}): PullRequestGenerationRecord | null {
  if (!record || record.context.requestId !== requestId || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    status: canceled ? 'canceled' : 'failed',
    result: null,
    error: canceled ? null : error,
    hydrated: false
  }
}

export function markPullRequestGenerationRequiresPushBeforeCreate({
  record,
  requestId
}: {
  record: PullRequestGenerationRecord | null | undefined
  requestId: number
}): PullRequestGenerationRecord | null {
  if (!record || record.context.requestId !== requestId || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    requiresPushBeforeCreate: true
  }
}

export function clearPullRequestGenerationRequiresPushBeforeCreate(
  record: PullRequestGenerationRecord | null | undefined
): PullRequestGenerationRecord | null {
  if (!record) {
    return null
  }
  if (!record.requiresPushBeforeCreate) {
    return record
  }
  return {
    ...record,
    requiresPushBeforeCreate: false
  }
}

export function markPullRequestGenerationTerminalSeedRestored({
  record,
  requestId
}: {
  record: PullRequestGenerationRecord | null | undefined
  requestId: number
}): PullRequestGenerationRecord | null {
  if (
    !record ||
    record.context.requestId !== requestId ||
    record.hydrated ||
    (record.status !== 'failed' && record.status !== 'canceled')
  ) {
    return null
  }
  return {
    ...record,
    hydrated: true
  }
}

export function resolvePullRequestGenerationCancel(
  record: PullRequestGenerationRecord | null | undefined
): PullRequestGenerationRecord | null {
  if (!record || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    status: 'canceled',
    error: null,
    hydrated: false
  }
}

export const createPullRequestGenerationSlice: StateCreator<
  AppState,
  [],
  [],
  PullRequestGenerationSlice
> = (set) => ({
  pullRequestGenerationRequestSeq: 0,
  pullRequestGenerationRecords: {},
  allocatePullRequestGenerationRequestId: () => {
    let nextRequestId = 0
    set((state) => {
      nextRequestId = state.pullRequestGenerationRequestSeq + 1
      return {
        pullRequestGenerationRequestSeq: nextRequestId
      }
    })
    return nextRequestId
  },
  setPullRequestGenerationRecord: (key, record) =>
    set((state) => ({
      pullRequestGenerationRecords: {
        ...state.pullRequestGenerationRecords,
        [key]: record
      }
    })),
  updatePullRequestGenerationRecord: (key, updater) =>
    set((state) => {
      const nextRecord = updater(state.pullRequestGenerationRecords[key] ?? null)
      if (!nextRecord) {
        return state
      }
      return {
        pullRequestGenerationRecords: {
          ...state.pullRequestGenerationRecords,
          [key]: nextRecord
        }
      }
    }),
  prunePullRequestGenerationRecords: (liveWorktreeKeys) =>
    set((state) => {
      let changed = false
      const nextRecords: PullRequestGenerationRecords = {}
      for (const [key, record] of Object.entries(state.pullRequestGenerationRecords)) {
        const worktreeKey = getPullRequestGenerationWorktreeKey(
          record.context.worktreeId,
          record.context.worktreePath
        )
        if (worktreeKey && liveWorktreeKeys.has(worktreeKey)) {
          nextRecords[key] = record
        } else {
          changed = true
        }
      }
      return changed ? { pullRequestGenerationRecords: nextRecords } : state
    })
})
