/** Host-qualified catalogs can repeat bare workspace IDs, but workbench state/React keys cannot (STA-4846). Collapse duplicates before mounting or the same visible tabs mount twice. */
import { describe, expect, it, vi } from 'vitest'
import { projectWorkspaceSurfaces } from './workspace-surface-projection'
import { getIndexedAllWorktrees, getIndexedWorktreeMap } from '../store/worktree-repo-index'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Worktree } from '../../../shared/worktree/types'

const SHARED_WORKTREE_ID = 'repo-shared::/work/orca-feature'

// Production Git workspace collisions share repo/path because worktreeId encodes both (STA-4343).
const localWorktree: Worktree = {
  id: SHARED_WORKTREE_ID,
  repoId: 'repo-shared',
  path: '/work/orca-feature',
  hostId: 'local',
  head: 'abc123',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'orca-feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}
const sshWorktree: Worktree = { ...localWorktree, hostId: 'ssh:build-box' }

const localFolder: FolderWorkspace = {
  id: 'folder-shared',
  projectGroupId: 'group-shared',
  name: 'orca',
  folderPath: '/work/orca-local',
  executionHostId: 'local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}
const runtimeFolder: FolderWorkspace = {
  ...localFolder,
  folderPath: '/remote/orca',
  executionHostId: 'runtime:env-1'
}

function project(input: {
  worktrees?: readonly Worktree[]
  folderWorkspaces?: readonly FolderWorkspace[]
  activeWorkspaceId?: string | null
  activeWorkspaceResolvedHostId?: ExecutionHostId | null
}): ReturnType<typeof projectWorkspaceSurfaces> {
  return projectWorkspaceSurfaces({
    // Build through the real host index to test its composition with workbench collapse.
    worktreesById: getIndexedWorktreeMap({
      'repo-shared': [...(input.worktrees ?? [])]
    }),
    folderWorkspaces: input.folderWorkspaces ?? [],
    activeWorkspaceId: input.activeWorkspaceId ?? null,
    activeWorkspaceResolvedHostId: input.activeWorkspaceResolvedHostId ?? null
  })
}

describe('projectWorkspaceSurfaces', () => {
  it('emits one surface per workspace id when two hosts publish the same worktree', () => {
    const surfaces = project({ worktrees: [localWorktree, sshWorktree] })

    expect(surfaces).toEqual([{ id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }])
  })

  it('never emits a duplicate id, so mount loops cannot reuse a React key', () => {
    const surfaces = project({
      worktrees: [localWorktree, sshWorktree],
      folderWorkspaces: [localFolder, runtimeFolder]
    })

    expect(new Set(surfaces.map((surface) => surface.id)).size).toBe(surfaces.length)
  })

  it('emits one surface per folder workspace id across hosts', () => {
    const surfaces = project({
      folderWorkspaces: [localFolder, runtimeFolder]
    })

    expect(surfaces).toHaveLength(1)
    expect(surfaces[0]?.id).toBe('folder:folder-shared')
  })

  it('mounts the active folder workspace at its resolved host path, not the first row', () => {
    const surfaces = project({
      folderWorkspaces: [localFolder, runtimeFolder],
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'runtime:env-1'
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
  })

  it('ignores the active workspace id entirely when no resolved host disambiguates', () => {
    // With no resolved folder host, active ID is inert; the foundation relies on passing null to preserve projection identity.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const folderWorkspaces = [localFolder, runtimeFolder]
    const worktrees = [localWorktree]

    const withoutActiveId = project({ worktrees, folderWorkspaces, activeWorkspaceId: null })
    for (const activeWorkspaceId of [
      'folder:folder-shared',
      'folder:other-workspace',
      SHARED_WORKTREE_ID
    ]) {
      expect(project({ worktrees, folderWorkspaces, activeWorkspaceId })).toEqual(withoutActiveId)
    }
    warn.mockRestore()
  })

  it('keeps the first row when no resolved host disambiguates the folder collision', () => {
    const surfaces = project({
      folderWorkspaces: [runtimeFolder, localFolder]
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
  })

  it('keeps first-wins for a colliding folder workspace that is not the active one', () => {
    // A resolved host only breaks its own workspace's tie; another id's resolution must not move it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const surfaces = project({
      folderWorkspaces: [localFolder, runtimeFolder],
      activeWorkspaceId: 'folder:other-workspace',
      activeWorkspaceResolvedHostId: 'runtime:env-1'
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/work/orca-local' }])
    expect(warn).toHaveBeenCalledWith(
      '[workspace-surface] dropping colliding folder path',
      expect.objectContaining({
        kept: '/work/orca-local',
        dropped: '/remote/orca'
      })
    )
    warn.mockRestore()
  })

  it('keeps the resolved-host path when the colliding rows swap order', () => {
    // Reconnect can reverse catalog order; resolved folder host must retain the correct path.
    const surfaces = project({
      folderWorkspaces: [runtimeFolder, localFolder],
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'local'
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/work/orca-local' }])
  })

  it('switches the active folder path from first-wins to the host that hydrates', () => {
    // Until folder ownership resolves, ambiguous collisions remain first-wins.
    const folderWorkspaces = [localFolder, runtimeFolder]
    const hydrating = project({
      folderWorkspaces,
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: null
    })
    const hydrated = project({
      folderWorkspaces,
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'runtime:env-1'
    })

    expect(hydrating).toEqual([{ id: 'folder:folder-shared', path: '/work/orca-local' }])
    expect(hydrated).toEqual([{ id: 'folder:folder-shared', path: '/remote/orca' }])
    expect(hydrated[0]?.id).toBe(hydrating[0]?.id)
  })

  it('keeps the surviving host row when a runtime disconnect drops its peer', () => {
    // Runtime contact loss must preserve projected workspace IDs or mount pruning would unmount them.
    const surfaces = project({ worktrees: [localWorktree] })

    expect(surfaces).toEqual([{ id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }])
  })

  it('keeps distinct workspaces on one host', () => {
    const otherWorktree: Worktree = {
      ...localWorktree,
      id: 'repo-shared::/work/orca-other',
      path: '/work/orca-other'
    }

    expect(project({ worktrees: [localWorktree, otherWorktree] })).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' },
      { id: 'repo-shared::/work/orca-other', path: '/work/orca-other' }
    ])
  })
})

// Collapse may remove duplicates only; dropping an owned surface would destroy live terminals.
describe('projectWorkspaceSurfaces never under-selects', () => {
  const unqualifiedWorktree: Worktree = { ...localWorktree, hostId: undefined }
  const secondSshWorktree: Worktree = {
    ...localWorktree,
    hostId: 'ssh:ci-box'
  }
  const localOnlyFolder: FolderWorkspace = {
    ...localFolder,
    id: 'folder-local-only',
    executionHostId: undefined
  }

  it('emits every distinct id from a mixed local, SSH, runtime and folder catalog', () => {
    const distinctWorktree: Worktree = {
      ...sshWorktree,
      id: 'repo-shared::/work/orca-ssh-only',
      path: '/work/orca-ssh-only'
    }
    const distinctFolder: FolderWorkspace = {
      ...runtimeFolder,
      id: 'folder-runtime-only'
    }
    const worktrees = [localWorktree, sshWorktree, secondSshWorktree, distinctWorktree]
    const folderWorkspaces = [localFolder, runtimeFolder, localOnlyFolder, distinctFolder]

    const surfaceIds = project({ worktrees, folderWorkspaces }).map((surface) => surface.id)

    const expectedIds = new Set([
      ...worktrees.map((worktree) => worktree.id),
      ...folderWorkspaces.map((workspace) => `folder:${workspace.id}`)
    ])
    expect(new Set(surfaceIds)).toEqual(expectedIds)
    expect(surfaceIds).toHaveLength(expectedIds.size)
  })

  it('mounts a local-only catalog whose rows never name a host', () => {
    const otherUnqualified: Worktree = {
      ...unqualifiedWorktree,
      id: 'repo-shared::/work/orca-other',
      path: '/work/orca-other'
    }

    expect(
      project({
        worktrees: [unqualifiedWorktree, otherUnqualified],
        folderWorkspaces: [localOnlyFolder]
      })
    ).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' },
      { id: 'repo-shared::/work/orca-other', path: '/work/orca-other' },
      { id: 'folder:folder-local-only', path: '/work/orca-local' }
    ])
  })

  it('keeps the id when an unqualified row collides with a host-qualified one', () => {
    // The host index preserves unqualified buckets too; workbench projection must still collapse duplicate IDs.
    expect(project({ worktrees: [unqualifiedWorktree, localWorktree] })).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }
    ])
    expect(project({ worktrees: [localWorktree, unqualifiedWorktree] })).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }
    ])
  })

  it('collapses two SSH hosts publishing one worktree id, with no local row present', () => {
    expect(project({ worktrees: [sshWorktree, secondSshWorktree] })).toEqual([
      { id: SHARED_WORKTREE_ID, path: '/work/orca-feature' }
    ])
  })

  it('keeps a git worktree and a folder workspace apart even on the same id text', () => {
    const surfaces = project({
      worktrees: [{ ...localWorktree, id: 'folder-shared', path: '/work/collide' }],
      folderWorkspaces: [localFolder]
    })

    expect(surfaces).toEqual([
      { id: 'folder-shared', path: '/work/collide' },
      { id: 'folder:folder-shared', path: '/work/orca-local' }
    ])
  })

  it('collapses folder rows across three hosts to one surface without losing the id', () => {
    const sshFolder: FolderWorkspace = {
      ...localFolder,
      folderPath: '/ssh/orca',
      executionHostId: undefined,
      connectionId: 'build-box'
    }

    const surfaces = project({
      folderWorkspaces: [localFolder, runtimeFolder, sshFolder],
      activeWorkspaceId: 'folder:folder-shared',
      activeWorkspaceResolvedHostId: 'ssh:build-box'
    })

    expect(surfaces).toEqual([{ id: 'folder:folder-shared', path: '/ssh/orca' }])
  })

  it('does not let a folder row that names no host win the local tie-break', () => {
    // Do not let default-local ownership promote unstamped paths over explicitly local rows.
    const unstampedPeer: FolderWorkspace = {
      ...localFolder,
      folderPath: '/unknown/orca',
      executionHostId: undefined,
      connectionId: undefined
    }

    expect(
      project({
        folderWorkspaces: [localFolder, unstampedPeer],
        activeWorkspaceId: 'folder:folder-shared',
        activeWorkspaceResolvedHostId: 'local'
      })
    ).toEqual([{ id: 'folder:folder-shared', path: '/work/orca-local' }])
  })

  it('emits nothing extra and nothing missing for an empty catalog', () => {
    expect(project({})).toEqual([])
  })
})

// Both worktree hooks read the same WeakMap snapshot, preserving Object.is update behavior after the feed change.
describe('worktree surface feed subscription identity', () => {
  const worktreesByRepo = { 'repo-shared': [localWorktree, sshWorktree] }

  it('returns a stable map for an unchanged slice and a fresh one after a replace', () => {
    expect(getIndexedWorktreeMap(worktreesByRepo)).toBe(getIndexedWorktreeMap(worktreesByRepo))
    expect(getIndexedWorktreeMap({ ...worktreesByRepo })).not.toBe(
      getIndexedWorktreeMap(worktreesByRepo)
    )
  })

  it('exposes the same id set the host-qualified array does', () => {
    expect(new Set(getIndexedWorktreeMap(worktreesByRepo).keys())).toEqual(
      new Set(getIndexedAllWorktrees(worktreesByRepo).map((worktree) => worktree.id))
    )
  })
})
