import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import { refreshHostedReviewCard } from '../../hosted-review'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import {
  persistPassiveWorktreeMetaForOwner,
  trySettingsForWorktreeOwner,
  warnAmbiguousOwnerOnce
} from '../listing/worktree-owner-settings'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'
import {
  bumpFolderWorkspaceActivity,
  clearFolderWorkspaceUnread,
  markFolderWorkspaceUnread
} from './folder-workspace-unread-activity'

export function createMarkWorktreeUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['markWorktreeUnread'] {
  return (worktreeId) => {
    // Why: attention dot stays until the user engages the worktree; cleared by pane interaction or activation.
    const now = Date.now()
    if (markFolderWorkspaceUnread(set, get, worktreeId, now)) {
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || worktree.isUnread) {
        return {}
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: true,
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: true,
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? { worktreesByRepo: nextWorktrees, sortEpoch: s.sortEpoch + 1 }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    persistPassiveWorktreeMetaForOwner(
      get,
      worktreeId,
      { isUnread: true, lastActivityAt: now },
      'persist unread worktree state'
    )
  }
}

export function createObserveTerminalGitHubPullRequestLink(
  _set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['observeTerminalGitHubPullRequestLink'] {
  return (worktreeId, link) => {
    const state = get()
    const worktree = findKnownWorktreeById(state, worktreeId)
    if (!worktree || worktree.isBare || worktree.isArchived) {
      return
    }
    const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
    if (!repo || (repo.kind && repo.kind !== 'git')) {
      return
    }
    if (typeof worktree.linkedPR === 'number' && worktree.linkedPR !== link.number) {
      return
    }

    const branch = branchName(worktree.branch)
    const alreadyLinked = worktree.linkedPR === link.number

    const fetchPRForBranch = get().fetchPRForBranch
    if (typeof fetchPRForBranch === 'function') {
      void fetchPRForBranch(repo.path, branch, {
        force: true,
        repoId: repo.id,
        worktreeId,
        linkedPRNumber: alreadyLinked ? link.number : null,
        fallbackPRNumber: null,
        fallbackPRSource: alreadyLinked ? null : 'explicit'
      }).then((pr) => {
        if (!alreadyLinked && pr?.number === link.number) {
          // Why: terminal output can carry arbitrary PR URLs (docs/agents/logs).
          // Persist only after branch lookup confirms it and the user hasn't picked another PR mid-flight.
          void get().updateWorktreeMeta(
            worktreeId,
            { linkedPR: link.number },
            {
              shouldApply: (currentWorktree) =>
                Boolean(
                  currentWorktree &&
                  !currentWorktree.isBare &&
                  !currentWorktree.isArchived &&
                  (currentWorktree.linkedPR == null || currentWorktree.linkedPR === link.number)
                )
            }
          )
        }
      })
      return
    }

    const fetchHostedReviewForBranch = get().fetchHostedReviewForBranch
    if (typeof fetchHostedReviewForBranch === 'function') {
      // Why: full app stores have fetchPRForBranch (syncs the hosted-review cache); this is only a slice-test fallback.
      void refreshHostedReviewCard(fetchHostedReviewForBranch, {
        repoPath: repo.path,
        repoId: repo.id,
        branch,
        linkedGitHubPR: alreadyLinked ? link.number : null,
        fallbackGitHubPR: null,
        linkedGitLabMR: worktree.linkedGitLabMR ?? null
      })
    }
  }
}

export function createClearWorktreeUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['clearWorktreeUnread'] {
  return (worktreeId) => {
    if (clearFolderWorkspaceUnread(set, get, worktreeId)) {
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not {}) to keep the object reference on this hot-path no-op (every keystroke), avoiding selector churn.
        return s
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        isUnread: false
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: false
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo ? { worktreesByRepo: nextWorktrees } : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    persistPassiveWorktreeMetaForOwner(
      get,
      worktreeId,
      { isUnread: false },
      'persist cleared unread worktree state'
    )
  }
}

export function createBumpWorktreeActivity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['bumpWorktreeActivity'] {
  return (worktreeId) => {
    const now = Date.now()
    if (bumpFolderWorkspaceActivity(set, get, worktreeId, now)) {
      return
    }
    let shouldPersist = false
    set((s) => {
      const worktree = findKnownWorktreeById(s, worktreeId)
      if (!worktree) {
        return {}
      }
      shouldPersist = true
      // Why: skip sortEpoch bump for the active worktree — its PTY events are click side-effects (reorder-on-click bug, PR #209).
      // lastActivityAt is still persisted so the next background-driven sortEpoch bump includes this worktree's score.
      const isActive = s.activeWorktreeId === worktreeId
      const nextWorktrees = applyWorktreeUpdates(s.worktreesByRepo, worktreeId, {
        lastActivityAt: now
      })
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        }
      )
      return {
        ...(nextWorktrees !== s.worktreesByRepo
          ? {
              worktreesByRepo: nextWorktrees,
              ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
            }
          : {}),
        ...(nextDetectedWorktrees !== s.detectedWorktreesByRepo
          ? { detectedWorktreesByRepo: nextDetectedWorktrees }
          : {})
      }
    })

    if (!shouldPersist) {
      return
    }

    const ownerSettings = trySettingsForWorktreeOwner(get(), worktreeId)
    if (!ownerSettings) {
      warnAmbiguousOwnerOnce(worktreeId, 'persist worktree activity timestamp')
      return
    }
    void persistWorktreeMeta(ownerSettings, worktreeId, {
      lastActivityAt: now
    }).catch((err) => {
      if (isRuntimeSelectorNotFoundError(err)) {
        return
      }
      console.error('Failed to persist worktree activity timestamp:', err)
      void get().fetchWorktrees(getRepoIdFromWorktreeId(worktreeId))
    })
  }
}
