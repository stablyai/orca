import type { GitPushTarget, GitStatusEntry, GitUpstreamStatus } from '../../../../shared/types'

export type ChecksPanelGitStatusContextInput = {
  repoId: string | null | undefined
  worktreeId: string | null | undefined
  worktreePath: string | null | undefined
  branch: string
  linkedGitHubPR?: number | null
  linkedGitLabMR?: number | null
  linkedBitbucketPR?: number | null
  linkedAzureDevOpsPR?: number | null
  linkedGiteaPR?: number | null
  runtimeEnvironmentId: string | null
  repoConnectionId: string | null
  pushTarget: GitPushTarget | null | undefined
  // Local execution host variant (`wsl:{distro}` vs `host`) so a Windows-host
  // result never authorizes a WSL context (or another distro), and vice versa.
  // Null for SSH/runtime contexts, which are already scoped by their host ids.
  localExecutionScope?: string | null
}

export type ChecksPanelGitStatusSnapshot = {
  contextKey: string
  hasUncommittedChanges: boolean
  remoteStatus: GitUpstreamStatus | undefined
  gitIdentity?: {
    head?: string
    branch?: string | null
  }
}

export type ChecksPanelGitStatusInputs = {
  hasUncommittedChanges: boolean | undefined
  remoteStatus: GitUpstreamStatus | undefined
}

export type ChecksPanelRefreshGitIdentitySnapshot =
  | {
      kind: 'missing'
    }
  | {
      kind: 'same'
    }
  | {
      kind: 'changed'
      head?: string
      branch: string | null
    }

export function buildChecksPanelGitStatusContextKey(
  input: ChecksPanelGitStatusContextInput
): string {
  return JSON.stringify({
    repoId: input.repoId ?? '',
    worktreeId: input.worktreeId ?? '',
    worktreePath: input.worktreePath ?? '',
    branch: input.branch,
    // Why: this key gates right-sidebar async commits too; link/unlink must
    // make pre-change PR refreshes stale even when repo/branch are unchanged.
    linkedGitHubPR: input.linkedGitHubPR ?? null,
    linkedGitLabMR: input.linkedGitLabMR ?? null,
    linkedBitbucketPR: input.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: input.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: input.linkedGiteaPR ?? null,
    runtimeEnvironmentId: input.runtimeEnvironmentId ?? '',
    repoConnectionId: input.repoConnectionId ?? '',
    localExecutionScope: input.localExecutionScope ?? null,
    pushTarget: input.pushTarget
      ? {
          remoteName: input.pushTarget.remoteName,
          branchName: input.pushTarget.branchName,
          remoteUrl: input.pushTarget.remoteUrl ?? null,
          remoteCreated: input.pushTarget.remoteCreated ?? false
        }
      : null
  })
}

export function shouldPollChecksPanelRuntimeSshStatus(input: {
  isPanelVisible: boolean
  runtimeEnvironmentId: string | null
  repoConnectionId: string | null
}): boolean {
  return (
    input.isPanelVisible && input.runtimeEnvironmentId !== null && input.repoConnectionId !== null
  )
}

export function shouldCommitChecksPanelGitStatusSnapshot(
  currentContextKey: string,
  requestContextKey: string
): boolean {
  return currentContextKey === requestContextKey
}

export function shouldCoalesceChecksPanelGitStatusSnapshotRefresh(
  inFlightContextKey: string | null,
  requestContextKey: string
): boolean {
  return inFlightContextKey === requestContextKey
}

export function shouldClearChecksPanelGitStatusSnapshot(
  snapshot: ChecksPanelGitStatusSnapshot | null,
  contextKey: string
): boolean {
  return snapshot?.contextKey !== contextKey
}

export function readChecksPanelGitStatusSnapshot(
  snapshot: ChecksPanelGitStatusSnapshot | null,
  contextKey: string
): ChecksPanelGitStatusInputs {
  if (!snapshot || snapshot.contextKey !== contextKey) {
    return {
      hasUncommittedChanges: undefined,
      remoteStatus: undefined
    }
  }

  return {
    hasUncommittedChanges: snapshot.hasUncommittedChanges,
    remoteStatus: snapshot.remoteStatus
  }
}

export function readChecksPanelPublishActionGitStatus(input: {
  snapshot: ChecksPanelGitStatusSnapshot | null
  contextKey: string
  fallbackEntries: GitStatusEntry[] | undefined
  fallbackRemoteStatus: GitUpstreamStatus | undefined
}): ChecksPanelGitStatusInputs {
  const snapshotInputs = readChecksPanelGitStatusSnapshot(input.snapshot, input.contextKey)
  if (snapshotInputs.hasUncommittedChanges !== undefined || !input.fallbackRemoteStatus) {
    return snapshotInputs
  }

  return {
    hasUncommittedChanges: (input.fallbackEntries?.length ?? 0) > 0,
    remoteStatus: input.fallbackRemoteStatus
  }
}

function canonicalBranchIdentity(branch: string | null | undefined): string {
  return (branch ?? '').replace(/^refs\/heads\//, '').trim()
}

export function readChecksPanelRefreshGitIdentitySnapshot(input: {
  snapshot: ChecksPanelGitStatusSnapshot | null
  contextKey: string
  currentBranch: string
}): ChecksPanelRefreshGitIdentitySnapshot {
  if (
    !input.snapshot ||
    input.snapshot.contextKey !== input.contextKey ||
    !input.snapshot.gitIdentity ||
    input.snapshot.gitIdentity.branch === undefined
  ) {
    return { kind: 'missing' }
  }

  if (
    canonicalBranchIdentity(input.snapshot.gitIdentity.branch) ===
    canonicalBranchIdentity(input.currentBranch)
  ) {
    return { kind: 'same' }
  }

  return {
    kind: 'changed',
    head: input.snapshot.gitIdentity.head,
    branch: input.snapshot.gitIdentity.branch
  }
}

export function hasChecksPanelGitStatusBranchChanged(input: {
  observedBranch: string | null | undefined
  currentBranch: string
}): boolean {
  return (
    canonicalBranchIdentity(input.observedBranch) !== canonicalBranchIdentity(input.currentBranch)
  )
}
