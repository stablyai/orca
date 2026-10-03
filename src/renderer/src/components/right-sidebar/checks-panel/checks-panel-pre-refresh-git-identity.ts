import type { MutableRefObject } from 'react'
import { getRuntimeGitStatus, getRuntimeGitUpstreamStatus } from '@/runtime/runtime-git-client'
import type { GitPushTarget } from '../../../../../shared/worktree/types'
import type { ChecksPanelGitStatusSnapshot } from '../checks-panel-git-status-snapshot'
import {
  hasChecksPanelGitStatusBranchChanged,
  readChecksPanelRefreshGitIdentitySnapshot,
  shouldCommitChecksPanelGitStatusSnapshot
} from '../checks-panel-git-status-snapshot'
import type { ChecksPanelManualRefreshInput } from './manual-refresh-dependencies'

export type ChecksPanelPreRefreshGitIdentityInput = {
  activeConnectionId?: string | null
  activeWorktreeId: string
  activeWorktreePath: string
  activeWorktreePushTarget?: GitPushTarget | null
  branch: string
  gitStatusSnapshot: ChecksPanelGitStatusSnapshot | null
  isCurrentRequest: () => boolean
  ownerSettings?: ChecksPanelManualRefreshInput['ownerSettings']
  panelContextKey: string
  panelContextKeyRef: MutableRefObject<string>
  setGitStatusSnapshot: ChecksPanelManualRefreshInput['setGitStatusSnapshot']
  updateWorktreeGitIdentity: ChecksPanelManualRefreshInput['updateWorktreeGitIdentity']
}

export type ChecksPanelPreRefreshGitIdentityOutcome = 'continue' | 'branch-changed'

export async function syncChecksPanelPreRefreshGitIdentity(
  input: ChecksPanelPreRefreshGitIdentityInput
): Promise<ChecksPanelPreRefreshGitIdentityOutcome> {
  const {
    activeConnectionId,
    activeWorktreeId,
    activeWorktreePath,
    activeWorktreePushTarget,
    branch,
    gitStatusSnapshot,
    isCurrentRequest,
    ownerSettings,
    panelContextKey,
    panelContextKeyRef,
    setGitStatusSnapshot,
    updateWorktreeGitIdentity
  } = input

  const snapshotIdentity = readChecksPanelRefreshGitIdentitySnapshot({
    snapshot: gitStatusSnapshot,
    contextKey: panelContextKey,
    currentBranch: branch
  })
  if (snapshotIdentity.kind === 'changed') {
    updateWorktreeGitIdentity(activeWorktreeId, {
      head: snapshotIdentity.head,
      branch: snapshotIdentity.branch
    })
    // Why: this click discovered a terminal branch switch; let branch-keyed render/effects restart instead of refreshing old PR data.
    return 'branch-changed'
  }
  try {
    const statusContext = {
      settings: ownerSettings,
      worktreeId: activeWorktreeId,
      worktreePath: activeWorktreePath,
      connectionId: activeConnectionId ?? undefined
    }
    const status = await getRuntimeGitStatus(statusContext, {
      admissionTier: 'interactive'
    })
    const observedBranch = status.branch ?? (status.head ? null : undefined)
    updateWorktreeGitIdentity(activeWorktreeId, {
      head: status.head,
      branch: observedBranch
    })
    if (
      observedBranch !== undefined &&
      hasChecksPanelGitStatusBranchChanged({ observedBranch, currentBranch: branch })
    ) {
      // Why: this click discovered a terminal branch switch; let branch-keyed render/effects restart instead of refreshing old PR data.
      return 'branch-changed'
    }
    let freshRemoteStatus = status.upstreamStatus
    if (activeWorktreePushTarget) {
      freshRemoteStatus = await getRuntimeGitUpstreamStatus(statusContext, activeWorktreePushTarget)
    } else if (
      !freshRemoteStatus ||
      (freshRemoteStatus.ahead > 0 &&
        freshRemoteStatus.behind > 0 &&
        freshRemoteStatus.behindCommitsArePatchEquivalent === undefined)
    ) {
      freshRemoteStatus = await getRuntimeGitUpstreamStatus(statusContext)
    }
    if (
      isCurrentRequest() &&
      shouldCommitChecksPanelGitStatusSnapshot(panelContextKeyRef.current, panelContextKey)
    ) {
      // Why: the Refresh click already paid for this status read; commit it so empty-state Publish/Create eligibility is fresh.
      setGitStatusSnapshot({
        contextKey: panelContextKey,
        hasUncommittedChanges: status.entries.length > 0,
        remoteStatus: freshRemoteStatus,
        gitIdentity: { head: status.head, branch: observedBranch }
      })
    }
  } catch (error) {
    console.warn('[ChecksPanel] pre-refresh git identity refresh failed', error)
  }
  return 'continue'
}
