import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type PullRequestFieldName = 'base' | 'title' | 'body' | 'draft'
export type PullRequestFieldRevisions = Record<PullRequestFieldName, number>

export type PullRequestGenerationFields = {
  base: string
  title: string
  body: string
  draft: boolean
}

export type PullRequestGenerationContext = {
  worktreeId: string | null
  worktreePath: string
  connectionId?: string
  requestId: number
  repoId: string
  branch: string
  jiraIssueKey?: string | null
  /** The worktree owner's transport, captured when the request started. */
  runtimeTarget: RuntimeClientTarget
  /** The copy `runtimeTarget` answers for, so a same-path twin isn't patched with its result. */
  ownerHostId?: ExecutionHostId | null
}

export type PullRequestGenerationStatus = 'idle' | 'running' | 'canceled' | 'failed' | 'succeeded'

export type PullRequestGenerationRecord = {
  context: PullRequestGenerationContext
  seed: PullRequestGenerationFields
  seedFieldRevisions: PullRequestFieldRevisions
  editedFields?: { fields: PullRequestGenerationFields; revisions: PullRequestFieldRevisions }
  requiresPushBeforeCreate: boolean
  status: PullRequestGenerationStatus
  result: PullRequestGenerationFields | null
  error: string | null
  hydrated: boolean
  autoSubmit?: boolean
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
