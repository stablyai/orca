// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'

const sidebar = vi.hoisted(() => ({ setRightSidebarTab: vi.fn(), setRightSidebarOpen: vi.fn() }))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => sidebar })
}))
vi.mock('../../../bots/bot-workspace', () => ({
  useBotForWorkspace: (workspaceId: string) =>
    workspaceId === 'folder:bot-home'
      ? {
          id: 'bot-1',
          name: 'Main X Manager',
          avatar: null,
          hostId: 'local',
          chatSessionId: 'home'
        }
      : null
}))
vi.mock('../../../bots/bot-avatar-image', () => ({ useBotAvatarSrc: () => null }))
vi.mock('./use-structured-chat-pane-actions', () => ({
  useStructuredChatPaneActions: () => ({ onSplitRight: vi.fn() })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutKeyComboDetails: () => [] }))
vi.mock('../../appearance/NativeChatSettingsButton', () => ({
  NativeChatSettingsButton: () => null
}))

function renderHeader(worktreeId: string, sessionId: string): void {
  render(
    <TooltipProvider>
      <NativeChatPaneHeader
        tabId={`tab-${sessionId}`}
        worktreeId={worktreeId}
        groupId="group-1"
        nativeChat={{ sessionId, agent: 'claude' }}
        focused
        colorScheme="dark"
      />
    </TooltipProvider>
  )
}

const OPEN_PAGE = "Open Main X Manager's page"

afterEach(cleanup)

describe("a bot's Home Chat banner", () => {
  it("floats the bot over its Home Chat and opens the bot's page", () => {
    renderHeader('folder:bot-home', 'home')
    fireEvent.click(screen.getByRole('button', { name: OPEN_PAGE }))
    expect(sidebar.setRightSidebarTab).toHaveBeenCalledWith('bot-activity')
    expect(sidebar.setRightSidebarOpen).toHaveBeenCalledWith(true)
  })

  it('stays off side chats and chats outside a bot page', () => {
    renderHeader('folder:bot-home', 'side')
    renderHeader('folder:project', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
  })
})
