import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { filterTabBarItemsForActiveView, type TabBarItem } from './tab-bar-item-model'

function makeTerminalItem(id: string): TabBarItem {
  const terminal: TerminalTab = {
    id,
    ptyId: null,
    worktreeId: 'worktree-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    type: 'terminal',
    id,
    unifiedTabId: id,
    isPinned: false,
    data: terminal
  }
}

function makeUnifiedTerminal(id: string, viewMode?: 'terminal' | 'chat'): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: 'worktree-1',
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    viewMode
  }
}

describe('Chat tab-strip partition', () => {
  const chatOne = makeTerminalItem('chat-1')
  const chatTwo = makeTerminalItem('chat-2')
  const shell = makeTerminalItem('shell-1')
  const lookup = new Map<string, Tab>([
    ['chat-1', makeUnifiedTerminal('chat-1', 'chat')],
    ['chat-2', makeUnifiedTerminal('chat-2', 'chat')],
    ['shell-1', makeUnifiedTerminal('shell-1', 'terminal')]
  ])

  it('shows chat sessions and hides raw terminal tabs while Chat is active', () => {
    const visible = filterTabBarItemsForActiveView([chatOne, shell, chatTwo], 'chat-1', lookup)

    expect(visible.map((item) => item.id)).toEqual(['chat-1', 'chat-2'])
  })

  it('keeps the complete workspace strip while Terminal is active', () => {
    const visible = filterTabBarItemsForActiveView([chatOne, shell, chatTwo], 'shell-1', lookup)

    expect(visible.map((item) => item.id)).toEqual(['chat-1', 'shell-1', 'chat-2'])
  })
})
