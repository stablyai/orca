import { describe, expect, it } from 'vitest'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorkspaceLineageMenuActions,
  hasSleepableWorkspaceActivity
} from './workspace-lineage-menu-actions'

function makeWorktree(id: string): Worktree {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId: 'repo-1',
    path: `/workspaces/${id}`,
    head: 'abc123',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
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
}

function makeLineage(child: Worktree, parent: Worktree): WorktreeLineage {
  return {
    worktreeId: child.id,
    worktreeInstanceId: child.instanceId ?? '',
    parentWorktreeId: parent.id,
    parentWorktreeInstanceId: parent.instanceId ?? '',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
}

describe('workspace lineage menu actions', () => {
  it('collects recursive descendants and only targets workspaces with active panels for sleep', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')
    const grandchild = makeWorktree('grandchild')
    const actions = getWorkspaceLineageMenuActions({
      parent,
      worktrees: [parent, child, grandchild],
      lineageById: {
        [child.id]: makeLineage(child, parent),
        [grandchild.id]: makeLineage(grandchild, child)
      },
      activity: {
        tabsByWorktree: {
          [parent.id]: [{ id: 'parent-tab' }],
          [child.id]: [{ id: 'child-tab' }],
          [grandchild.id]: [{ id: 'grandchild-tab' }]
        },
        ptyIdsByTabId: {
          'parent-tab': [],
          'child-tab': ['child-pty'],
          'grandchild-tab': []
        },
        browserTabsByWorktree: {
          [grandchild.id]: [{ id: 'grandchild-browser' }]
        }
      }
    })

    expect(actions.descendants.map((target) => target.id)).toEqual(['child', 'grandchild'])
    expect(actions.targets.map((target) => target.id)).toEqual(['parent', 'child', 'grandchild'])
    expect(actions.sleepableTargets.map((target) => target.id)).toEqual(['child', 'grandchild'])
  })

  it('does not expose stale descendants through the recursive action scope', () => {
    const parent = makeWorktree('parent')
    const child = makeWorktree('child')

    const actions = getWorkspaceLineageMenuActions({
      parent,
      worktrees: [parent, child],
      lineageById: {
        [child.id]: {
          ...makeLineage(child, parent),
          parentWorktreeInstanceId: 'stale-parent-instance'
        }
      },
      activity: {
        tabsByWorktree: { [child.id]: [{ id: 'child-tab' }] },
        ptyIdsByTabId: { 'child-tab': ['child-pty'] },
        browserTabsByWorktree: {}
      }
    })

    expect(actions.descendants).toEqual([])
    expect(actions.sleepableTargets).toEqual([])
  })
})

describe('hasSleepableWorkspaceActivity', () => {
  it('treats preserved empty PTY arrays as slept, not live', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        ptyIdsByTabId: { 'tab-1': [] },
        browserTabsByWorktree: {}
      })
    ).toBe(false)
  })

  it('detects live terminal and browser activity', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        browserTabsByWorktree: {}
      })
    ).toBe(true)
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: { 'wt-1': [{ id: 'browser-1' }] }
      })
    ).toBe(true)
  })
})
