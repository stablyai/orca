// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TabBarItemActions } from './use-tab-bar-item-actions'
import type { TabBarItem } from './tab-bar-item-model'
import TabBarItemRow from './TabBarItemRow'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({ unreadTerminalTabs: {}, unreadAgentCompletionPanes: {} })
}))
vi.mock('@/runtime/native-chat/naming/structured-conversation-name', () => ({
  useStructuredChatTabNaming: () => ({ name: null, forkSourceId: null }),
  useStructuredChatTabNamingFailure: () => null
}))
vi.mock('../../bots/BotGroupTabIcon', () => ({
  BotGroupTabIcon: () => null,
  useBotGroupTabMembers: () => []
}))
vi.mock('../../bots/bot-workspace', () => ({
  useBotForWorkspace: () => ({
    id: 'bot-1',
    name: 'pip',
    avatar: null,
    hostId: 'local',
    chatSessionId: 'home-chat'
  })
}))
vi.mock('../terminal-tabs/SortableTab', () => ({
  default: ({ identityIcon, closable }: { identityIcon?: ReactNode; closable?: boolean }) => (
    <div data-testid="tab" data-closable={String(closable)}>
      {identityIcon}
    </div>
  )
}))

function chatItem(sessionId: string): TabBarItem {
  return {
    type: 'agent-session',
    id: `tab-${sessionId}`,
    unifiedTabId: `tab-${sessionId}`,
    isPinned: false,
    data: {
      id: `tab-${sessionId}`,
      entityId: sessionId,
      groupId: 'group-1',
      worktreeId: 'folder:bot-home',
      contentType: 'agent-session',
      label: 'Home',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
  }
}

function renderRow(item: TabBarItem): void {
  render(
    <TabBarItemRow
      item={item}
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SortableTab is mocked, so no action runs
      actions={{} as TabBarItemActions}
      worktreeId="folder:bot-home"
      groupId="group-1"
      generatedTabTitlesEnabled={false}
      tabCount={2}
      hasTabsToLeft={false}
      hasTabsToRight
      isActive
      isExpanded={false}
      dropIndicator={null}
      includeTopTabBorder={false}
      canToggleViewMode={false}
      isChatView={false}
      viewModeTabId={undefined}
      canDuplicate={false}
      canCloseSplitPane={false}
      gitStatus={null}
    />
  )
}

afterEach(cleanup)

describe('TabBarItemRow bot Home tab', () => {
  it("shows the bot's avatar like its side chats, and still cannot close", () => {
    renderRow(chatItem('home-chat'))
    const home = screen.getByTestId('tab')
    expect(home.textContent).toBe('P')
    expect(home.querySelector('svg')).toBeNull()
    expect(home.dataset.closable).toBe('false')
  })
})
