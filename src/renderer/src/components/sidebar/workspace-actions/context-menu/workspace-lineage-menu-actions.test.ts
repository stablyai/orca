import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { describe, expect, it } from 'vitest'

import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

import { getWorkspaceLineageMenuActions } from './workspace-lineage-menu-actions'

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
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
        structuredChatSleptAtByPaneKey: {}
      }
    })

    expect(actions.descendants).toEqual([])
    expect(actions.sleepableTargets).toEqual([])
  })
})
