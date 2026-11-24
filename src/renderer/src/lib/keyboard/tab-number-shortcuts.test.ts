import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { resolveTabNumberShortcutTarget } from './tab-number-shortcuts'

const WORKTREE = 'folder:bot-home'

function chatTab(id: string, entityId: string): Tab {
  return {
    id,
    entityId,
    groupId: 'group',
    worktreeId: WORKTREE,
    executionHostId: 'local',
    contentType: 'agent-session',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

// Stored order holds two side chats ahead of Home, as after a restore or a newly opened tab.
const state = {
  activeView: 'terminal' as const,
  activeWorktreeId: WORKTREE,
  activeGroupIdByWorktree: { [WORKTREE]: 'group' },
  groupsByWorktree: {
    [WORKTREE]: [
      {
        id: 'group',
        worktreeId: WORKTREE,
        activeTabId: 'side-a',
        tabOrder: ['side-a', 'side-b', 'home']
      }
    ]
  },
  unifiedTabsByWorktree: {
    [WORKTREE]: [
      chatTab('side-a', 'side-a-chat'),
      chatTab('side-b', 'side-b-chat'),
      chatTab('home', 'home-chat')
    ]
  },
  repos: [],
  settings: null,
  worktreesByRepo: {}
}

describe('resolveTabNumberShortcutTarget', () => {
  it("counts a bot's Home first, as its tab bar shows it", () => {
    const homeBot = (): { chatSessionId: string } => ({ chatSessionId: 'home-chat' })
    expect(resolveTabNumberShortcutTarget(state, 0, homeBot)?.id).toBe('home')
    expect(resolveTabNumberShortcutTarget(state, 1, homeBot)?.id).toBe('side-a')
  })

  it('keeps the stored order off a bot page', () => {
    expect(resolveTabNumberShortcutTarget(state, 0, () => null)?.id).toBe('side-a')
  })
})
