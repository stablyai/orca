import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { applyWorktreeUpdates, getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { branchName } from '@/lib/git-utils'
import { refreshHostedReviewCard } from '../../hosted-review'
import {
  applyDetectedWorktreeUpdates,
  findKnownWorktreeById
} from '../listing/detected-worktree-meta'
import { getFolderWorkspaceActivityPersistence } from './folder-workspace-activity'
import {
  persistPassiveWorktreeMetaForOwner,
  trySettingsForWorktreeOwner,
  warnAmbiguousOwnerOnce
} from '../listing/worktree-owner-settings'
import { persistWorktreeMeta } from '../metadata/worktree-meta-persist'
import { isRuntimeSelectorNotFoundError } from '../listing/runtime-worktree-rpc-errors'

export function createMarkWorktreeUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['markWorktreeUnread'] {
  return (worktreeId) => {
    // Why: attention dot stays until the user engages the worktree; cleared by pane interaction or activation.
    const now = Date.now()
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      let shouldPersist = false
      set((s) => {
        const folderWorkspace = s.folderWorkspaces.find(
          (workspace) => workspace.id === folderWorkspaceId
        )
        if (!folderWorkspace || folderWorkspace.isUnread) {
          return s
        }
        shouldPersist = true
        return {
          folderWorkspaces: s.folderWorkspaces.map((workspace) =>
            workspace.id === folderWorkspaceId
              ? { ...workspace, isUnread: true, lastActivityAt: now }
              : workspace
          ),
          sortEpoch: s.sortEpoch + 1
        }
      })
      if (!shouldPersist) {
        return
      }
      void get().updateFolderWorkspace(folderWorkspaceId, {
        isUnread: true,
        lastActivityAt: now
      })
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
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      const folderWorkspace = get().folderWorkspaces.find(
        (workspace) => workspace.id === folderWorkspaceId
      )
      if (!folderWorkspace?.isUnread) {
        return
      }
      // Why: flip locally first — this runs per keystroke, so the guard above must dedupe before the IPC round-trip lands.
      set((s) => ({
        folderWorkspaces: s.folderWorkspaces.map((workspace) =>
          workspace.id === folderWorkspaceId ? { ...workspace, isUnread: false } : workspace
        )
      }))
      void get().updateFolderWorkspace(folderWorkspaceId, { isUnread: false })
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
    const workspaceScope = parseWorkspaceKey(worktreeId)
    if (workspaceScope?.type === 'folder') {
      // Why: folder meta lives on the FolderWorkspace record — persistWorktreeMeta would write a
      // worktreeMeta['folder:…'] row that folderWorkspaces:list never reads back (#10251).
      const folderWorkspaceId = workspaceScope.folderWorkspaceId
      let shouldPersist = false
      set((s) => {
        if (!s.folderWorkspaces.some((workspace) => workspace.id === folderWorkspaceId)) {
          return s
        }
        shouldPersist = true
        const isActive = s.activeWorktreeId === worktreeId
        return {
          folderWorkspaces: s.folderWorkspaces.map((workspace) =>
            workspace.id === folderWorkspaceId ? { ...workspace, lastActivityAt: now } : workspace
          ),
          // Why: active-workspace PTY events are click side-effects, so they must not reorder it.
          ...(isActive ? {} : { sortEpoch: s.sortEpoch + 1 })
        }
      })
      if (shouldPersist) {
        getFolderWorkspaceActivityPersistence(get).record(folderWorkspaceId, now)
      }
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
