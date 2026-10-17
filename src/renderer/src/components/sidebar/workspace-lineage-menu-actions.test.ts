import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
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
        },
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {},
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {}
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
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {},
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {}
      }
    })

    expect(actions.descendants).toEqual([])
    expect(actions.sleepableTargets).toEqual([])
  })
})

function hostHeld(tab: Tab): Record<string, { structuredHostOwned: true }> {
  return { [structuredAgentSessionPaneKey(tab.id, tab.entityId)]: { structuredHostOwned: true } }
}

describe('hasSleepableWorkspaceActivity', () => {
  it('treats preserved empty PTY arrays as slept, not live', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        ptyIdsByTabId: { 'tab-1': [] },
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {},
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {}
      })
    ).toBe(false)
  })

  it('detects live terminal and browser activity', () => {
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
        ptyIdsByTabId: { 'tab-1': ['pty-1'] },
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {},
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {}
      })
    ).toBe(true)
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: { 'wt-1': [{ id: 'browser-1' }] },
        unifiedTabsByWorktree: {},
        agentStatusByPaneKey: {},
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {}
      })
    ).toBe(true)
  })

  it('offers Sleep for a chat-only workspace while its host holds the chat', () => {
    const chat: Tab = {
      id: 'chat-1',
      entityId: 'session-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    expect(
      hasSleepableWorkspaceActivity('wt-1', {
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: {},
        unifiedTabsByWorktree: { 'wt-1': [chat] },
        agentStatusByPaneKey: hostHeld(chat),
        explicitlySleptChatsByWorkspace: {},
        chatOwnerState: {
          worktreesByRepo: {
            'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }]
          }
        }
      })
    ).toBe(true)
    expect(
      hasSleepableWorkspaceActivity(
        { id: 'wt-1', repoId: 'repo-1', hostId: 'local' },
        {
          tabsByWorktree: {},
          ptyIdsByTabId: {},
          browserTabsByWorktree: {},
          unifiedTabsByWorktree: { 'wt-1': [{ ...chat, executionHostId: 'runtime:remote' }] },
          agentStatusByPaneKey: hostHeld(chat),
          explicitlySleptChatsByWorkspace: {},
          chatOwnerState: {}
        }
      )
    ).toBe(false)
  })

  it('offers Sleep for an ended chat until an explicit Sleep records it', () => {
    const chat: Tab = {
      id: 'chat-1',
      entityId: 'session-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      executionHostId: 'local',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const activity = (
      slept: { tabId: string; sessionId: string }[]
    ): Parameters<typeof hasSleepableWorkspaceActivity>[1] => ({
      tabsByWorktree: {},
      ptyIdsByTabId: {},
      browserTabsByWorktree: {},
      unifiedTabsByWorktree: { 'wt-1': [chat] },
      agentStatusByPaneKey: {},
      explicitlySleptChatsByWorkspace: { 'local|wt-1': slept },
      chatOwnerState: {
        worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }] }
      }
    })
    expect(hasSleepableWorkspaceActivity('wt-1', activity([]))).toBe(true)
    expect(
      hasSleepableWorkspaceActivity('wt-1', activity([{ tabId: 'chat-1', sessionId: 'session-1' }]))
    ).toBe(false)
    // A replaced session is a new chat the earlier Sleep never covered.
    expect(
      hasSleepableWorkspaceActivity('wt-1', activity([{ tabId: 'chat-1', sessionId: 'old' }]))
    ).toBe(true)
  })

  it('offers Sleep for the selected host of a duplicate chat-only folder', () => {
    const chat: Tab = {
      id: 'chat-folder',
      entityId: 'session-folder',
      groupId: 'group-1',
      worktreeId: 'folder:folder-1',
      contentType: 'agent-session',
      agentSessionAgent: 'claude',
      executionHostId: 'runtime:env-1',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    expect(
      hasSleepableWorkspaceActivity(
        { id: 'folder:folder-1', hostId: 'runtime:env-1' },
        {
          tabsByWorktree: {},
          ptyIdsByTabId: {},
          browserTabsByWorktree: {},
          unifiedTabsByWorktree: { 'folder:folder-1': [chat] },
          agentStatusByPaneKey: hostHeld(chat),
          explicitlySleptChatsByWorkspace: {},
          chatOwnerState: {
            folderWorkspaces: [
              {
                id: 'folder-1',
                projectGroupId: 'local-group',
                connectionId: null,
                executionHostId: 'local'
              },
              {
                id: 'folder-1',
                projectGroupId: 'remote-group',
                connectionId: null,
                executionHostId: 'runtime:env-1'
              }
            ],
            projectGroups: [
              { id: 'remote-group', connectionId: null, executionHostId: 'runtime:env-1' }
            ]
          }
        }
      )
    ).toBe(true)
  })
})
