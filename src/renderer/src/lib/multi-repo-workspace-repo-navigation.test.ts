import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../shared/multi-repo-workspace'

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))

const { activateWorkspaceRepoEntry, resolveWorkspaceRepoTarget } =
  await import('./multi-repo-workspace-repo-navigation')
const { activateAndRevealWorkspace } = await import('@/lib/worktree-activation')

function member(id: string, state: MultiRepoMember['state']): MultiRepoMember {
  return {
    memberId: id,
    repoId: id,
    dirName: id,
    branchName: 'b',
    state,
    attempts: 0,
    ...(state === 'ready' ? { worktreeId: `wt-${id}` } : {})
  }
}

function workspace(members: MultiRepoMember[]): FolderWorkspace {
  return {
    id: 'f1',
    projectGroupId: 'project-1',
    name: 'Workspace',
    folderPath: '/workspace/f1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    multiRepo: { version: 1, executionHostId: 'local', rootOwnedByOrca: true, members }
  }
}

const folderWorkspaces = [
  workspace([member('a', 'ready'), member('b', 'failed'), member('c', 'ready')])
]
const resolve = (
  activeWorktreeId: string | null,
  selection: Parameters<typeof resolveWorkspaceRepoTarget>[1]
) => resolveWorkspaceRepoTarget({ folderWorkspaces, activeWorktreeId }, selection)?.workspaceKey

describe('resolveWorkspaceRepoTarget', () => {
  it('steps through the workspace folder and ready members, wrapping at both ends', () => {
    expect(resolve('folder:f1', { kind: 'next' })).toBe('wt-a')
    expect(resolve('wt-a', { kind: 'next' })).toBe('wt-c')
    expect(resolve('wt-c', { kind: 'next' })).toBe('folder:f1')
    expect(resolve('folder:f1', { kind: 'previous' })).toBe('wt-c')
  })

  it('skips members that are not ready', () => {
    expect(resolve('wt-a', { kind: 'next' })).toBe('wt-c')
    expect(resolve('wt-c', { kind: 'previous' })).toBe('wt-a')
  })

  it('does nothing outside a multi-repo workspace', () => {
    expect(resolve('wt-other', { kind: 'next' })).toBeUndefined()
    expect(resolve(null, { kind: 'next' })).toBeUndefined()
  })
})

describe('activateWorkspaceRepoEntry', () => {
  it('qualifies activation with the host the adoption stamped, not the one the owning host wrote', () => {
    const adopted: FolderWorkspace = {
      ...workspace([member('a', 'ready')]),
      executionHostId: 'runtime:env-a'
    }
    activateWorkspaceRepoEntry('wt-a', adopted)
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('wt-a', {
      navigationIntent: 'user-open',
      executionHostId: 'runtime:env-a'
    })
  })

  it('falls back to the multi-repo host when the workspace carries no stamp', () => {
    activateWorkspaceRepoEntry('wt-a', workspace([member('a', 'ready')]))
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('wt-a', {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
  })
})
