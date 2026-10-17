import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import { addHostSectionRows } from '../../../../shared/sidebar-list/host-section-rows'

const LOCAL: Repo = {
  id: 'local',
  path: '/local',
  displayName: 'local',
  badgeColor: '#000000',
  addedAt: 0,
  connectionId: null
}

function worktree(id: string): Worktree {
  return {
    id,
    repoId: LOCAL.id,
    path: `/${LOCAL.id}/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: true,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function pinnedItem(id: string): Extract<Row, { type: 'item' }> {
  return {
    type: 'item',
    rowKey: `${PINNED_GROUP_KEY}:${id}`,
    sectionKey: PINNED_GROUP_KEY,
    worktree: worktree(id),
    repo: LOCAL,
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: true,
    lineageChildCount: 0
  }
}

describe('addHostSectionRows counted workspace ids', () => {
  it('gives each host section of a split lane its own counted workspace ids', () => {
    const sshPinned = pinnedItem('ssh-pinned')
    sshPinned.worktree.hostId = 'ssh:ssh-1'
    const splitHeader: Extract<Row, { type: 'header' }> = {
      type: 'header',
      key: PINNED_GROUP_KEY,
      count: 2,
      icon: { kind: 'pinned' },
      hostWorktreeCounts: new Map([
        ['local', 1],
        ['ssh:ssh-1', 1]
      ]),
      hostWorktreeIds: new Map([
        ['local', ['wt-1']],
        ['ssh:ssh-1', ['ssh-pinned']]
      ]),
      worktreeIds: ['wt-1', 'ssh-pinned'],
      // A folder workspace is counted on its host even though it is never a worktree id.
      countedWorkspaceIds: ['wt-1', 'ssh-pinned', 'folder:ssh-f'],
      hostCountedWorkspaceIds: new Map([
        ['local', ['wt-1']],
        ['ssh:ssh-1', ['ssh-pinned', 'folder:ssh-f']]
      ])
    }

    const sectioned = addHostSectionRows({
      rows: [splitHeader, pinnedItem('wt-1'), sshPinned],
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        { id: 'ssh:ssh-1', kind: 'ssh', label: 'Builder', detail: 'SSH', health: 'available' }
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local'
    })

    expect(
      sectioned.filter((row) => row.type === 'header' && row.key === PINNED_GROUP_KEY)
    ).toMatchObject([
      { hostId: 'local', countedWorkspaceIds: ['wt-1'] },
      { hostId: 'ssh:ssh-1', countedWorkspaceIds: ['ssh-pinned', 'folder:ssh-f'] }
    ])
  })
})
