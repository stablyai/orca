import { expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { projectWorkspaceBoardFolders } from './workspace-board-folder-cards'

it('folds the attached host copy only while its folder has a visible card', () => {
  const folder: FolderWorkspace = {
    id: 'ticket',
    projectGroupId: 'monorepo',
    name: 'Ticket',
    folderPath: '/project',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const local = makeWorktree({ id: 'repo::/checkout', repoId: 'repo', hostId: 'local' })
  const args = {
    folders: [folder],
    childrenByParentIdentity: new Map([['local|folder:ticket', [local]]]),
    visibleGitIdentities: new Set(['local|repo::/checkout', 'ssh:remote|repo::/checkout'])
  }
  const visible = projectWorkspaceBoardFolders({ ...args, visibleHostIds: null })
  expect(visible.folders.map((card) => card.id)).toEqual(['folder:ticket'])
  expect([...visible.visibleIdentities]).toEqual([
    'ssh:remote|repo::/checkout',
    'local|folder:ticket'
  ])
  const archived = projectWorkspaceBoardFolders({
    ...args,
    folders: [{ ...folder, isArchived: true }],
    visibleHostIds: null
  })
  expect(archived.folders).toEqual([])
  expect(archived.visibleIdentities.has('local|repo::/checkout')).toBe(true)
})
