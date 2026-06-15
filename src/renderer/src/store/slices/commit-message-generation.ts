import type { StateCreator } from 'zustand'
import type { GlobalSettings } from '../../../../shared/types'
import type { AppState } from '../types'

export type CommitMessageGenerationRuntimeTargetSettings = Pick<
  GlobalSettings,
  'activeRuntimeEnvironmentId'
>

export type CommitMessageGenerationContext = {
  worktreeId: string
  worktreePath: string
  connectionId?: string
  requestId: number
  runtimeTargetSettings?: CommitMessageGenerationRuntimeTargetSettings | null
}

export type CommitMessageGenerationStatus = 'idle' | 'running' | 'canceled' | 'failed' | 'succeeded'

export type CommitMessageGenerationRecord = {
  context: CommitMessageGenerationContext
  status: CommitMessageGenerationStatus
  message: string | null
  error: string | null
  hydrated: boolean
}

export type CommitMessageGenerationRecords = Record<string, CommitMessageGenerationRecord>

export type CommitMessageGenerationSlice = {
  commitMessageGenerationRequestSeq: number
  commitMessageGenerationRecords: CommitMessageGenerationRecords
  allocateCommitMessageGenerationRequestId: () => number
  setCommitMessageGenerationRecord: (key: string, record: CommitMessageGenerationRecord) => void
  updateCommitMessageGenerationRecord: (
    key: string,
    updater: (record: CommitMessageGenerationRecord | null) => CommitMessageGenerationRecord | null
  ) => void
  pruneCommitMessageGenerationRecords: (liveWorktreeKeys: ReadonlySet<string>) => void
}

export function getCommitMessageGenerationRecordKey(
  worktreeId: string | null | undefined,
  worktreePath: string | null | undefined
): string | null {
  if (worktreeId) {
    return worktreeId
  }
  return worktreePath?.trim() ? worktreePath : null
}

export function createRunningCommitMessageGenerationRecord(
  context: CommitMessageGenerationContext
): CommitMessageGenerationRecord {
  return {
    context,
    status: 'running',
    message: null,
    error: null,
    hydrated: false
  }
}

export function resolveCommitMessageGenerationSuccess({
  record,
  requestId,
  message
}: {
  record: CommitMessageGenerationRecord | null | undefined
  requestId: number
  message: string
}): CommitMessageGenerationRecord | null {
  if (!record || record.context.requestId !== requestId || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    status: 'succeeded',
    message,
    error: null,
    hydrated: false
  }
}

export function resolveCommitMessageGenerationFailure({
  record,
  requestId,
  error,
  canceled = false
}: {
  record: CommitMessageGenerationRecord | null | undefined
  requestId: number
  error: string | null
  canceled?: boolean
}): CommitMessageGenerationRecord | null {
  if (!record || record.context.requestId !== requestId || record.status !== 'running') {
    return null
  }
  return {
    ...record,
    status: canceled ? 'canceled' : 'failed',
    message: null,
    error: canceled ? null : error,
    hydrated: false
  }
}

export function resolveCommitMessageGenerationCancel(
  record: CommitMessageGenerationRecord | null | undefined
): CommitMessageGenerationRecord | null {
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

export function markCommitMessageGenerationHydrated(
  record: CommitMessageGenerationRecord | null | undefined
): CommitMessageGenerationRecord | null {
  if (!record || record.status !== 'succeeded') {
    return null
  }
  return {
    ...record,
    hydrated: true
  }
}

export const createCommitMessageGenerationSlice: StateCreator<
  AppState,
  [],
  [],
  CommitMessageGenerationSlice
> = (set) => ({
  commitMessageGenerationRequestSeq: 0,
  commitMessageGenerationRecords: {},
  allocateCommitMessageGenerationRequestId: () => {
    let nextRequestId = 0
    set((state) => {
      nextRequestId = state.commitMessageGenerationRequestSeq + 1
      return {
        commitMessageGenerationRequestSeq: nextRequestId
      }
    })
    return nextRequestId
  },
  setCommitMessageGenerationRecord: (key, record) =>
    set((state) => ({
      commitMessageGenerationRecords: {
        ...state.commitMessageGenerationRecords,
        [key]: record
      }
    })),
  updateCommitMessageGenerationRecord: (key, updater) =>
    set((state) => {
      const nextRecord = updater(state.commitMessageGenerationRecords[key] ?? null)
      if (!nextRecord) {
        return {}
      }
      return {
        commitMessageGenerationRecords: {
          ...state.commitMessageGenerationRecords,
          [key]: nextRecord
        }
      }
    }),
  pruneCommitMessageGenerationRecords: (liveWorktreeKeys) =>
    set((state) => {
      let changed = false
      const nextRecords: CommitMessageGenerationRecords = {}
      for (const [key, record] of Object.entries(state.commitMessageGenerationRecords)) {
        const worktreeKey = getCommitMessageGenerationRecordKey(
          record.context.worktreeId,
          record.context.worktreePath
        )
        if (worktreeKey && liveWorktreeKeys.has(worktreeKey)) {
          nextRecords[key] = record
        } else {
          changed = true
        }
      }
      return changed ? { commitMessageGenerationRecords: nextRecords } : {}
    })
})
