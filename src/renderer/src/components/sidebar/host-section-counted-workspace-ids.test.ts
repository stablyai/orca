import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { PINNED_GROUP_KEY } from '../../../../shared/sidebar-list/group-keys'
import type { Row } from '../../../../shared/sidebar-list/row-types'
import {
  addHostSectionRows,
  type HostSectionOption,
  type HostSectionRow
} from '../../../../shared/sidebar-list/host-section-rows'

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

function splitPinnedLane(): Row[] {
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
  return [splitHeader, pinnedItem('wt-1'), sshPinned]
}

function sshHost(id: ExecutionHostId, label: string): HostSectionOption {
  return { id, kind: 'ssh', label, detail: 'SSH', health: 'available' }
}

function pinnedHeaders(rows: readonly HostSectionRow[]): HostSectionRow[] {
  return rows.filter((row) => row.type === 'header' && row.key === PINNED_GROUP_KEY)
}

describe('addHostSectionRows counted workspace ids', () => {
  it('gives each host section of a split lane its own counted workspace ids', () => {
    const sectioned = addHostSectionRows({
      rows: splitPinnedLane(),
      hostOptions: [
        {
          id: 'local',
          kind: 'local',
          label: 'Local Mac',
          detail: 'This computer',
          health: 'local'
        },
        sshHost('ssh:ssh-1', 'Builder')
      ],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      localHostLabel: 'Local Mac'
    })

    expect(pinnedHeaders(sectioned)).toMatchObject([
      { hostId: 'local', countedWorkspaceIds: ['wt-1'] },
      { hostId: 'ssh:ssh-1', countedWorkspaceIds: ['ssh-pinned', 'folder:ssh-f'] }
    ])
  })

  it('keeps per-host counted workspace ids when the local host falls back to its label', () => {
    const sectioned = addHostSectionRows({
      rows: splitPinnedLane(),
      hostOptions: [sshHost('ssh:ssh-1', 'Builder'), sshHost('ssh:ssh-2', 'Spare')],
      workspaceHostScope: 'all',
      defaultHostId: 'local',
      localHostLabel: 'Local Windows'
    })

    expect(sectioned.filter((row) => row.type === 'host-header')).toMatchObject([
      { hostId: 'ssh:ssh-1', label: 'Builder' },
      { hostId: 'local', label: 'Local Windows' }
    ])
    expect(pinnedHeaders(sectioned)).toMatchObject([
      { hostId: 'ssh:ssh-1', countedWorkspaceIds: ['ssh-pinned', 'folder:ssh-f'] },
      { hostId: 'local', countedWorkspaceIds: ['wt-1'] }
    ])
  })
})
