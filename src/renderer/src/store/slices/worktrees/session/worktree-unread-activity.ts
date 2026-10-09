import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { applyWorktreeUpdates } from '../../worktree-helpers'
import { applyDetectedWorktreeUpdates } from '../listing/detected-worktree-meta'
import { getFolderWorkspaceActivityPersistence } from './folder-workspace-activity'
import {
  persistPassiveWorktreeMetaForOwner,
  resolvePassiveWorktreeMetaOwner,
  passiveWorktreeMetaUpdateGuard
} from '../listing/worktree-owner-settings'

export function createMarkWorktreeUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['markWorktreeUnread'] {
  return (worktreeId, qualification) => {
    if (qualification === null) {
      return
    }
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
    const owner = resolvePassiveWorktreeMetaOwner(get(), worktreeId, qualification)
    if (!owner) {
      return
    }
    const guard = passiveWorktreeMetaUpdateGuard(owner.worktree)
    let shouldPersist = false
    set((s) => {
      const worktree = owner.worktree
      if (!worktree || worktree.isUnread) {
        return s
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(
        s.worktreesByRepo,
        worktreeId,
        {
          isUnread: true,
          lastActivityAt: now
        },
        worktree.hostId,
        guard
      )
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: true,
          lastActivityAt: now
        },
        worktree.hostId,
        guard
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
      'persist unread worktree state',
      { owner }
    )
  }
}

export function createClearWorktreeUnread(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['clearWorktreeUnread'] {
  return (worktreeId, qualification) => {
    if (qualification === null) {
      return
    }
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
    const owner = resolvePassiveWorktreeMetaOwner(get(), worktreeId, qualification)
    if (!owner) {
      return
    }
    const guard = passiveWorktreeMetaUpdateGuard(owner.worktree)
    let shouldPersist = false
    set((s) => {
      const worktree = owner.worktree
      if (!worktree || !worktree.isUnread) {
        // Why: return `s` (not {}) to keep the object reference on this hot-path no-op (every keystroke), avoiding selector churn.
        return s
      }
      shouldPersist = true
      const nextWorktrees = applyWorktreeUpdates(
        s.worktreesByRepo,
        worktreeId,
        {
          isUnread: false
        },
        worktree.hostId,
        guard
      )
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          isUnread: false
        },
        worktree.hostId,
        guard
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
      'persist cleared unread worktree state',
      { owner }
    )
  }
}

export function createBumpWorktreeActivity(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['bumpWorktreeActivity'] {
  return (worktreeId, qualification) => {
    if (qualification === null) {
      return
    }
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
    const owner = resolvePassiveWorktreeMetaOwner(get(), worktreeId, qualification)
    if (!owner) {
      return
    }
    const guard = passiveWorktreeMetaUpdateGuard(owner.worktree)
    let shouldPersist = false
    set((s) => {
      const worktree = owner.worktree
      if (!worktree) {
        return s
      }
      shouldPersist = true
      // Why: skip sortEpoch bump for the active worktree — its PTY events are click side-effects (reorder-on-click bug, PR #209).
      // lastActivityAt is still persisted so the next background-driven sortEpoch bump includes this worktree's score.
      const isActive = s.activeWorktreeId === worktreeId
      const nextWorktrees = applyWorktreeUpdates(
        s.worktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        },
        worktree.hostId,
        guard
      )
      const nextDetectedWorktrees = applyDetectedWorktreeUpdates(
        s.detectedWorktreesByRepo,
        worktreeId,
        {
          lastActivityAt: now
        },
        worktree.hostId,
        guard
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

    persistPassiveWorktreeMetaForOwner(
      get,
      worktreeId,
      { lastActivityAt: now },
      'persist worktree activity timestamp',
      { owner, reconcileSelectorMiss: false }
    )
  }
}
