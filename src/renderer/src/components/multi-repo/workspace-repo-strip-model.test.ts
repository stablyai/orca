import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { MultiRepoMember } from '../../../../shared/multi-repo-workspace'
import type { Repo } from '../../../../shared/repo-types'
import { buildWorkspaceRepoStripModel } from './workspace-repo-strip-model'

function member(id: string, state: MultiRepoMember['state']): MultiRepoMember {
  return {
    memberId: id,
    repoId: `repo-${id}`,
    dirName: id,
    branchName: 'flow',
    state,
    attempts: 0,
    ...(state === 'ready' ? { worktreeId: `wt-${id}` } : {})
  }
}

function workspace(members: MultiRepoMember[], multiRepo = true): FolderWorkspace {
  return {
    id: 'f1',
    projectGroupId: 'g1',
    name: 'checkout-flow',
    folderPath: '/w/f1',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...(multiRepo
      ? { multiRepo: { version: 1, executionHostId: 'local', rootOwnedByOrca: true, members } }
      : {})
  }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal repo fixtures; the model reads only id and displayName.
const repos = [
  { id: 'repo-a', displayName: 'api' },
  { id: 'repo-b', displayName: 'web' }
] as unknown as Repo[]
const input = (activeWorktreeId: string | null, folderWorkspaces: FolderWorkspace[]) => ({
  activeWorktreeId,
  folderWorkspaces,
  repos,
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the status map is only counted, never read by entry shape.
  gitStatusByWorktree: { 'wt-a': [{}, {}, {}] } as never
})

describe('buildWorkspaceRepoStripModel', () => {
  const ws = workspace([member('a', 'ready'), member('b', 'ready'), member('c', 'failed')])

  it('lists All and the ready repos with counts only where status is known', () => {
    const model = buildWorkspaceRepoStripModel(input('folder:f1', [ws]))
    expect(model?.entries.map((e) => [e.key, e.kind, e.label, e.active, e.changedCount])).toEqual([
      ['folder:f1', 'all', '', true, null],
      ['wt-a', 'repo', 'api', false, 3],
      ['wt-b', 'repo', 'web', false, null]
    ])
  })

  it('stays visible when a child repo is the active workspace', () => {
    const model = buildWorkspaceRepoStripModel(input('wt-b', [ws]))
    expect(model?.entries.find((e) => e.active)?.key).toBe('wt-b')
  })

  it('is hidden for other workspaces, plain folder workspaces and nothing active', () => {
    expect(buildWorkspaceRepoStripModel(input('wt-other', [ws]))).toBeNull()
    expect(buildWorkspaceRepoStripModel(input(null, [ws]))).toBeNull()
    expect(buildWorkspaceRepoStripModel(input('folder:f1', [workspace([], false)]))).toBeNull()
  })

  it('does not offer a failed member as a destination', () => {
    const model = buildWorkspaceRepoStripModel(input('folder:f1', [ws]))
    expect(model?.entries.some((e) => e.key.includes('c'))).toBe(false)
  })
})
