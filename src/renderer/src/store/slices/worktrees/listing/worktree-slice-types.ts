import type { StateCreator } from 'zustand'
import type { AppState } from '../../../types'
import type { WorktreeSlice } from '../../worktree-helpers'
import type {
  DetectedWorktreeListResult,
  GitPushTarget,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { DirectSshAuthority } from '../../../../../../shared/ssh-types'
import type { HostQualifiedDetectedWorktreeResult } from '../../../../../../shared/detected-worktree-provider-contract'
import type { ProjectHostSetup } from '../../../../../../shared/project-types'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'

export type WorktreeSliceGet = Parameters<StateCreator<AppState>>[1]
export type WorktreeSliceSet = Parameters<StateCreator<AppState, [], [], WorktreeSlice>>[0]

export type BackgroundRuntimeRefreshOptions = {
  reuseRecentCompatibilityFailure?: boolean
}

export type DetectedWorktreeRefreshOptions = BackgroundRuntimeRefreshOptions & {
  executionHostId: ExecutionHostId
  requireAuthoritative?: boolean
  directSshAuthority?: DirectSshAuthority
  // Why (#10562): the caller's own view of what it is about to purge. Teardown is
  // requested per caller, so this must never be shared with a coalesced scan.
  connectionId?: string | null
  knownWorktreeIds?: readonly string[]
}

export type AdmittedDetectedWorktreeRefresh = {
  status: 'admitted'
  result: DetectedWorktreeListResult
  providerResult?: HostQualifiedDetectedWorktreeResult
  executionHostId: ExecutionHostId
  directSshAuthority?: DirectSshAuthority
  runtimeAuthority?: {
    environmentId: string
    connectionGeneration: number
    runtimeConnectionGeneration: number
  }
}

export type DetectedWorktreeRefreshOutcome =
  | AdmittedDetectedWorktreeRefresh
  | {
      status: 'not-admitted'
      providerResult: HostQualifiedDetectedWorktreeResult
      executionHostId: ExecutionHostId
      directSshAuthority?: DirectSshAuthority
    }

export type WorktreeWithLineage = Worktree & {
  parentWorktreeId?: string | null
  childWorktreeIds?: string[]
  lineage?: WorktreeLineage | null
}

export type WorktreeHostMatchOptions = {
  unhostedWorktreesMatchHost?: boolean
}

export type RepoHostSummary = {
  count: number
  onlyHostId?: ExecutionHostId
}

export type WorktreeLineageUpdateResult = {
  target: ReturnType<typeof getActiveRuntimeTarget>
  lineage: WorktreeLineage | null
  updatedRemoteWorktree?: WorktreeWithLineage
}

export type HostedReviewLinkKey =
  | 'linkedPR'
  | 'linkedGitLabMR'
  | 'linkedBitbucketPR'
  | 'linkedAzureDevOpsPR'
  | 'linkedGiteaPR'

export type RuntimeWorktreeMetaUpdates = Omit<Partial<WorktreeMeta>, 'pushTarget'> & {
  pushTarget?: GitPushTarget | null
}

export type FencedWorktreeMergeArgs = {
  repoId: string
  hostId: ExecutionHostId
  ownerWasMissingAtStart: boolean
  missingDirectSshOwnerReposSnapshot?: AppState['repos']
  requestStartedWorktrees: readonly Worktree[] | undefined
  setup?: ProjectHostSetup
  refresh: AdmittedDetectedWorktreeRefresh
  purgeRemovedWorktrees?: boolean
}
