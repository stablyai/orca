import type { ExecutionHostId } from './execution-host'
import type { Repo } from './repo-types'

// The explicit opt-in on a registration request; `hostId` is the alias the caller reaches this host through.
export type RepositoryAddScriptRequest = { hostId: ExecutionHostId }

// Where an approved script runs; `cwd` is a host path for native and a guest path for WSL.
export type RepositoryAddScriptTarget =
  | { kind: 'native'; cwd: string }
  | { kind: 'wsl'; distro: string; cwd: string }

export type RepositoryAddScriptPreview = {
  token: string
  hostId: ExecutionHostId
  hostLabel: string
  repoId: string
  path: string
  target: RepositoryAddScriptTarget
  script: string
  scriptHash: string
}

/** The user's choice on the prompt; closing the prompt is a skip, never a run. */
export type RepositoryAddScriptPromptDecision = 'run' | 'skip'

export type RepositoryAddScriptDecision = {
  token: string
  hostId: ExecutionHostId
  repoId: string
  decision: RepositoryAddScriptPromptDecision
}

// The identity a caller must present to read an outcome; the token alone is not enough.
export type RepositoryAddScriptIdentity = Pick<
  RepositoryAddScriptDecision,
  'token' | 'hostId' | 'repoId'
>

export type RepositoryAddScriptExecutionResult = {
  // Absent when no exit was observed (timeout, signal); never substitute a number.
  exitCode?: number
  // Set when a stopped process could not be proven gone; it may still be running.
  processVerdict?: 'unverifiable'
  output: string
  outputTruncated?: boolean
}

export type RepositoryAddScriptOutcome =
  | { status: 'pending' | 'running' | 'skipped' | 'stale' | 'revoked' }
  | {
      status: 'succeeded' | 'failed'
      exitCode?: number
      output: string
      outputTruncated: boolean
    }
  | { status: 'failed'; reason: 'execution-failed' }
  // The script was stopped but its processes were not proven gone; never an ordinary failure.
  | { status: 'unverifiable'; output: string; outputTruncated: boolean }

export type RepositoryAddScriptDecisionResult =
  | RepositoryAddScriptOutcome
  | {
      status: 'rejected'
      reason: 'invalid-token' | 'used-token' | 'identity-mismatch' | 'invalid-decision'
    }

// Optional on a registration result; only a row this request inserted can carry one.
export type RepositoryAddScriptRegistrationFields = {
  repositoryAddScriptPreview?: RepositoryAddScriptPreview
}

export type RepoWithRepositoryAddScriptPreview = {
  repo: Repo
} & RepositoryAddScriptRegistrationFields
