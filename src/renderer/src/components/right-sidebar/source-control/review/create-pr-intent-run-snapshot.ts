import { bulkStageRuntimeGitPaths } from '@/runtime/runtime-git-working-tree-client'
import { operationGitContext } from '../listing/operation-target'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import {
  createPrIntentGitStatusMatchesToken,
  getCreatePrIntentStagePaths,
  type CreatePrIntentRunToken
} from './create-pr-intent-flow'
import type { SourceControlOperationTarget } from '../listing/operation-target'
import type { SourceControlWorktreeContext } from '../listing/use-worktree-context'
import type { SourceControlCreatePrIntentProbes } from './use-create-pr-intent-probes'

export type CreatePrIntentRunSnapshot = {
  abortIfStale: () => boolean
  readonly entries: GitStatusEntry[]
  refreshIntentSnapshot: () => Promise<boolean>
  stageLatestIntentPaths: () => Promise<boolean>
  readonly upstreamStatus: SourceControlWorktreeContext['remoteStatus']
  wasAbortedByStaleTarget: () => boolean
}

/** Use closure state so each async step reads the previous write without waiting for React. */
export function createCreatePrIntentRunSnapshot({
  initialEntries,
  initialUpstreamStatus,
  operationTarget,
  refreshGitStatusForCreatePrIntent,
  runIsCurrent,
  setIsExecutingBulk,
  token
}: {
  initialEntries: GitStatusEntry[]
  initialUpstreamStatus: SourceControlWorktreeContext['remoteStatus']
  operationTarget: SourceControlOperationTarget
  refreshGitStatusForCreatePrIntent: SourceControlCreatePrIntentProbes['refreshGitStatusForCreatePrIntent']
  runIsCurrent: () => boolean
  setIsExecutingBulk: (value: boolean) => void
  token: CreatePrIntentRunToken
}): CreatePrIntentRunSnapshot {
  let latestStatusEntries = initialEntries
  let latestUpstreamStatus = initialUpstreamStatus
  let abortedByStaleTarget = false

  const abortIfStale = (): boolean => {
    if (runIsCurrent()) {
      return false
    }
    abortedByStaleTarget = true
    return true
  }

  const refreshIntentSnapshot = async (): Promise<boolean> => {
    const refreshed = await refreshGitStatusForCreatePrIntent(token)
    if (!refreshed) {
      return false
    }
    // Stop if a terminal checkout reaches this snapshot before React updates the target ref.
    if (!createPrIntentGitStatusMatchesToken(token, refreshed.status)) {
      abortedByStaleTarget = true
      return false
    }
    if (abortIfStale()) {
      return false
    }
    latestStatusEntries = refreshed.status.entries
    latestUpstreamStatus = refreshed.upstreamStatus
    return true
  }

  const stageLatestIntentPaths = async (): Promise<boolean> => {
    const stagePaths = getCreatePrIntentStagePaths({
      unstaged: latestStatusEntries.filter((entry) => entry.area === 'unstaged'),
      untracked: latestStatusEntries.filter((entry) => entry.area === 'untracked')
    })
    if (stagePaths.length === 0) {
      return true
    }
    setIsExecutingBulk(true)
    try {
      await bulkStageRuntimeGitPaths(operationGitContext(operationTarget), stagePaths)
    } finally {
      setIsExecutingBulk(false)
    }
    if (abortIfStale()) {
      return false
    }
    return refreshIntentSnapshot()
  }

  return {
    abortIfStale,
    get entries() {
      return latestStatusEntries
    },
    refreshIntentSnapshot,
    stageLatestIntentPaths,
    get upstreamStatus() {
      return latestUpstreamStatus
    },
    wasAbortedByStaleTarget: () => abortedByStaleTarget
  }
}
