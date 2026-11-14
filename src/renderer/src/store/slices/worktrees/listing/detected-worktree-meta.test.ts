import { describe, expect, it } from 'vitest'

import { findKnownWorktreeById } from './detected-worktree-meta'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../../../components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { resolveQualifiedFolderWorkspaceResult } from '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { Repo } from '../../../../../../shared/repo-types'

describe('inherited folder consumer identity', () => {
  it.each(['group', 'repo'])(
    'invalidates only a changed derived host projection from its %s catalog',
    (source) => {
      const folder = makeFolderWorkspace()
      const repo: Repo = {
        id: 'repo',
        path: '/repo/platform/hi/repo',
        projectGroupId: folder.projectGroupId,
        displayName: 'Repo',
        addedAt: 1,
        badgeColor: 'blue',
        kind: 'git'
      }
      const initial = {
        folderWorkspaces: [folder],
        projectGroups: [makeProjectGroup()],
        repos: [repo],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        floatingWorkspacePath: null
      }
      const first = findKnownWorktreeById(initial, `folder:${folder.id}`)
      expect(first?.hostId).toBe('local')
      expect(findKnownWorktreeById({ ...initial }, `folder:${folder.id}`)).toBe(first)
      const next =
        source === 'group'
          ? {
              ...initial,
              projectGroups: [{ ...makeProjectGroup(), executionHostId: 'ssh:box' as const }]
            }
          : { ...initial, repos: [{ ...repo, executionHostId: 'ssh:box' as const }] }
      expect(resolveQualifiedFolderWorkspaceResult(next, folder.id).kind).toBe('selected')
      const changed = findKnownWorktreeById(next, `folder:${folder.id}`)
      expect(changed?.hostId).toBe('ssh:box')
      expect(changed).not.toBe(first)
      expect(findKnownWorktreeById(next, `folder:${folder.id}`)).toBe(changed)
    }
  )
})

describe('selected folder catalog replacement', () => {
  it('observes a folder added to a replacement catalog and preserves qualified lookup', () => {
    const folderWorkspaces = [makeFolderWorkspace({ id: 'existing' })]
    const state = {
      folderWorkspaces,
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {},
      floatingWorkspacePath: null
    }
    expect(findKnownWorktreeById(state, 'folder:missing', 'local')).toBeUndefined()
    const folder = makeFolderWorkspace({ id: 'missing', folderPath: '/new-folder' })
    const next = { ...state, folderWorkspaces: [...folderWorkspaces, folder] }
    expect(findKnownWorktreeById(next, 'folder:missing', 'local')?.path).toBe('/new-folder')
    const narrow = {
      ...state,
      folderWorkspaces: [folder],
      projectGroups: undefined,
      repos: undefined
    }
    expect(findKnownWorktreeById(narrow, 'folder:missing')?.path).toBe('/new-folder')
    expect(findKnownWorktreeById(narrow, 'folder:missing', 'local')).toBeUndefined()
  })
})
