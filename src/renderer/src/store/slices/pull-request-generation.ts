import type { StateCreator } from 'zustand'
import type { GlobalSettings } from '../../../../shared/types'
import type { AppState } from '../types'

export type PullRequestFieldName = 'base' | 'title' | 'body' | 'draft'
export type PullRequestFieldRevisions = Record<PullRequestFieldName, number>

export type PullRequestGenerationFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

export type PullRequestGenerationRuntimeTargetSettings = Pick<
  GlobalSettings,
  'activeRuntimeEnvironmentId'
>

export type PullRequestGenerationContext = {
  worktreeId: string | null
  worktreePath: string
  connectionId?: string
  requestId: number
  repoId: string
  branch: string
  runtimeTargetSettings?: PullRequestGenerationRuntimeTargetSettings | null
}

export type PullRequestGenerationStatus = 'idle' | 'running' | 'canceled' | 'failed' | 'succeeded'

export type PullRequestGenerationRecord = {
  context: PullRequestGenerationContext
  seed: PullRequestGenerationFields
  seedFieldRevisions: PullRequestFieldRevisions
  requiresPushBeforeCreate: boolean
  status: PullRequestGenerationStatus
  result: PullRequestGenerationFields | null
  error: string | null
  hydrated: boolean
}

export type PullRequestGenerationRecords = Record<string, PullRequestGenerationRecord>

export type PullRequestGenerationSlice = {
  pullRequestGenerationRequestSeq: number
  pullRequestGenerationRecords: PullRequestGenerationRecords
  allocatePullRequestGenerationRequestId: () => number
  setPullRequestGenerationRecord: (key: string, record: PullRequestGenerationRecord) => void
  updatePullRequestGenerationRecord: (
    key: string,
    updater: (record: PullRequestGenerationRecord | null) => PullRequestGenerationRecord | null
  ) => void
  prunePullRequestGenerationRecords: (liveWorktreeKeys: ReadonlySet<string>) => void
}

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
  seedFieldRevisions: PullRequestFieldRevisions
): PullRequestGenerationRecord {
  return {
    context,
    seed,
    seedFieldRevisions,
    requiresPushBeforeCreate: false,
    status: 'running',
    result: null,
    error: null,
    hydrated: false
  }
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
    result,
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
        return {}
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
      return changed ? { pullRequestGenerationRecords: nextRecords } : {}
    })
})
