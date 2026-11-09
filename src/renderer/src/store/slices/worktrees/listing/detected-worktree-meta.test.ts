import { describe, expect, it } from 'vitest'
import { hostWorktreeTarget } from '../../../../../../shared/worktree/host-qualified-identity'

import { findKnownWorktreeById } from './detected-worktree-meta'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../../../../components/sidebar/workspace-creation/folder/folder-workspace-composer-submit-fixtures'
import { findFolderWorkspaceOwner } from '@/lib/workspace/ownership/folder-workspace-runtime-owner'
import { selectWorkspaceByHostTarget } from '../../../workspaces/selection/workspace-host-target'
import { resolveWorkspaceDirectory } from '@/lib/workspace-directory'
import { resolveQualifiedFolderWorkspaceResult } from '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import { findIndexedFolderWorkspaceOwner } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { resolveNotificationTabOwner } from '@/attention/notification-subject-owner'
import { getWorktreeDeleteStateKey } from '../teardown/worktree-delete-state'

describe('inherited folder consumer identity', () => {
  it.each([false, true])(
    'keeps physical twins qualified through native owner, store and directory, reversed=%s',
    (reverse) => {
      const inherited = makeFolderWorkspace({
        id: 'same',
        projectGroupId: 'inherited',
        folderPath: '/remote'
      })
      const local = makeFolderWorkspace({
        id: 'same',
        executionHostId: 'local',
        folderPath: '/local'
      })
      const folderWorkspaces = reverse ? [inherited, local] : [local, inherited]
      const state = {
        folderWorkspaces,
        projectGroups: [{ id: 'inherited', executionHostId: 'ssh:box' as const }],
        repos: [],
        worktreesByRepo: {},
        detectedWorktreesByRepo: {},
        floatingWorkspacePath: null
      }
      const raw = findIndexedFolderWorkspaceOwner(folderWorkspaces, 'same', 'ssh:box')
      const converted = folderWorkspaceToWorktree(inherited)
      const notification = resolveNotificationTabOwner(state, {
        worktreeId: 'folder:same',
        executionHostId: 'ssh:box'
      })
      expect(resolveQualifiedFolderWorkspaceResult(state, 'same', 'ssh:box').kind).toBe('selected')
      expect(findFolderWorkspaceOwner(state, 'same', 'ssh:box')).toBe(inherited)
      const projected = findKnownWorktreeById(state, 'folder:same', 'ssh:box')
      expect(projected).toMatchObject({ path: '/remote', hostId: 'ssh:box' })
      expect(
        selectWorkspaceByHostTarget(
          state,
          hostWorktreeTarget({ id: 'folder:same', hostId: 'ssh:box' })
        )
      ).toBe(projected)
      expect(resolveWorkspaceDirectory(state, 'folder:same', 'ssh:box')).toBe('/remote')
      expect(findKnownWorktreeById(state, 'folder:same')).toBeUndefined()
      expect(findIndexedFolderWorkspaceOwner(folderWorkspaces, 'same', 'ssh:box')).toBe(raw)
      expect(folderWorkspaceToWorktree(inherited)).toEqual(converted)
      expect(
        resolveNotificationTabOwner(state, {
          worktreeId: 'folder:same',
          executionHostId: 'ssh:box'
        })
      ).toEqual(notification)
      expect(inherited.executionHostId).toBeUndefined()
      expect(getWorktreeDeleteStateKey(state, 'folder:same', 'ssh:box')).not.toBe(
        getWorktreeDeleteStateKey(state, 'folder:same', 'local')
      )
    }
  )
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
