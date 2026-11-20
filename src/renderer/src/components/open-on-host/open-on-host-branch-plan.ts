import type { GitUpstreamStatus } from '../../../../shared/git/status/git-status-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'

export type WorkspaceSyncOffer = 'none' | 'push' | 'publish'

export function getWorkspaceSyncOffer(upstream: GitUpstreamStatus): WorkspaceSyncOffer {
  if (!upstream.hasUpstream) {
    return 'publish'
  }
  return upstream.ahead > 0 ? 'push' : 'none'
}

export type WorkspaceOnHostPlan =
  | { kind: 'blocked'; reason: 'detached' | 'unpublished' }
  | {
      kind: 'ready'
      sync: WorkspaceSyncOffer
      /** Commits that stay on the source because the push was declined. */
      localOnlyCommits: number
      /** True when the host should end up at the source's HEAD. */
      expectSameHead: boolean
    }

export function planWorkspaceOnHost(input: {
  branch: string
  upstream: GitUpstreamStatus
  syncFirst: boolean
}): WorkspaceOnHostPlan {
  const { branch, upstream, syncFirst } = input
  if (!branch) {
    return { kind: 'blocked', reason: 'detached' }
  }
  const offer = getWorkspaceSyncOffer(upstream)
  if (offer === 'none') {
    // Behind means the host opens at the remote tip, which differs from the source HEAD.
    return {
      kind: 'ready',
      sync: 'none',
      localOnlyCommits: 0,
      expectSameHead: upstream.behind === 0
    }
  }
  if (syncFirst) {
    return { kind: 'ready', sync: offer, localOnlyCommits: 0, expectSameHead: true }
  }
  if (offer === 'publish') {
    // The host can only fetch what exists on a remote.
    return { kind: 'blocked', reason: 'unpublished' }
  }
  return { kind: 'ready', sync: 'none', localOnlyCommits: upstream.ahead, expectSameHead: false }
}

/** The remote and branch the host fetches and opens; pushTarget wins over the upstream name. */
export function resolveHostRemoteBranch(
  upstream: GitUpstreamStatus,
  pushTarget?: GitPushTarget
): { remoteName: string; branchName: string } | null {
  if (pushTarget) {
    return { remoteName: pushTarget.remoteName, branchName: pushTarget.branchName }
  }
  const name = upstream.upstreamName
  const slash = name?.indexOf('/') ?? -1
  if (!name || slash <= 0) {
    return null
  }
  // shortcut: a remote name containing '/' is misread; read remotes from git if that ever shows up
  return { remoteName: name.slice(0, slash), branchName: name.slice(slash + 1) }
}
