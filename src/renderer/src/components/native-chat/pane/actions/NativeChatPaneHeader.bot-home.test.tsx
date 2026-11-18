// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'

const sidebar = vi.hoisted(() => ({ setRightSidebarTab: vi.fn(), setRightSidebarOpen: vi.fn() }))
const owner = vi.hoisted(() => ({ hostId: 'local' }))
const state = vi.hoisted(() => ({
  workspaceSessionReady: true,
  unifiedTabsByWorktree: {
    'folder:bot-home': [
      {
        id: 'tab-home',
        entityId: 'home',
        worktreeId: 'folder:bot-home',
        contentType: 'agent-session',
        executionHostId: 'local'
      }
    ]
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => sidebar
  })
}))
vi.mock('../../../bots/bot-workspace', () => ({
  useBotForWorkspace: (workspaceId: string) =>
    workspaceId === 'folder:bot-home'
      ? {
          id: 'bot-1',
          name: 'Main X Manager',
          avatar: null,
          hostId: owner.hostId,
          folderWorkspaceId: 'bot-home',
          chatSessionId: 'home'
        }
      : null
}))
vi.mock('../../../bots/bot-avatar-image', () => ({ useBotAvatarSrc: () => null }))
vi.mock('./use-structured-chat-pane-actions', () => ({
  useStructuredChatPaneActions: () => ({ onSplitRight: vi.fn() })
}))
vi.mock('@/lib/keyboard/useShortcutLabel', () => ({ useShortcutKeyComboDetails: () => [] }))
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
beforeEach(() => {
  owner.hostId = 'local'
})

describe("a bot's Home Chat banner", () => {
  it('offers the banner only on the Home tab of a locally hosted agent', () => {
    renderHeader('folder:bot-home', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).not.toBeNull()
    cleanup()
    renderHeader('folder:bot-home', 'side')
    renderHeader('folder:project', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
    cleanup()
    owner.hostId = 'runtime:paired'
    renderHeader('folder:bot-home', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
  })
})
