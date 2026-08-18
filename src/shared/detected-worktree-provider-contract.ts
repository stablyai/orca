import type { ExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import type { DirectSshAuthority } from './ssh-types'
import type { DetectedWorktreeListResult } from './worktree/types'

export const PROVIDER_REQUEST_ID_MAX_UTF8_BYTES = 128
export type ProviderRequestId = string & { readonly __providerRequestId: unique symbol }
export type SshExecutionHostId = Extract<ExecutionHostId, `ssh:${string}`>

export type LocalDetectedWorktreeRequest = {
  providerRequestId: ProviderRequestId
  repoId: string
  executionHostId: typeof LOCAL_EXECUTION_HOST_ID
}

export type DirectSshDetectedWorktreeRequest = {
  providerRequestId: ProviderRequestId
  repoId: string
  executionHostId: SshExecutionHostId
  expectedAuthority: DirectSshAuthority
}

export type ListDetectedWorktreesArgs =
  | LocalDetectedWorktreeRequest
  | DirectSshDetectedWorktreeRequest

export type ListKnownWorktreesForExecutionHostArgs = {
  repoId: string
  executionHostId: SshExecutionHostId
}

export type HostQualifiedKnownWorktreeResult =
  | {
      status: 'complete'
      repoId: string
      executionHostId: SshExecutionHostId
      result: DetectedWorktreeListResult
    }
  | {
      status: 'rejected'
      repoId: string
      executionHostId: SshExecutionHostId
    }

export type ForgetRemovedWorktreesForExecutionHostArgs = {
  repoId: string
  executionHostId: SshExecutionHostId
  /** Ids an authoritative scan of this host proved gone — the only evidence that retires persisted metadata. */
  worktreeIds: readonly string[]
}

export type ForgetRemovedWorktreesForExecutionHostResult = {
  forgottenWorktreeIds: string[]
}

export type AuthoritativeDetectedWorktreeHost =
  | {
      kind: 'local'
      executionHostId: typeof LOCAL_EXECUTION_HOST_ID
    }
  | ({
      kind: 'direct-ssh'
      executionHostId: SshExecutionHostId
    } & DirectSshAuthority)

export type HostQualifiedDetectedWorktreeResult =
  | {
      status: 'complete' | 'non-authoritative'
      providerRequestId: ProviderRequestId
      repoId: string
      authority: AuthoritativeDetectedWorktreeHost
      result: DetectedWorktreeListResult
    }
  | {
      providerRequestId: ProviderRequestId
      executionHostId: ExecutionHostId
      status:
        | 'canceled'
        | 'timed-out'
        | 'stale'
        | 'ambiguous-owner'
        | 'authority-unknown'
        | 'rejected'
    }

export type LegacyDetectedWorktreeRequest = { repoId: string }
