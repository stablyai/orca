// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'
import { pairedHostStatuses } from '@/lib/bot-host-capability.test-fixture'

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
vi.mock('@/lib/bot-host-status', async () => {
  const { botHomeRuleApplies } = await import('@/lib/bot-host-capability')
  return {
    useBotHomeRuleApplies: (bot: Parameters<typeof botHomeRuleApplies>[0]) =>
      botHomeRuleApplies(bot, servers)
  }
})
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
const servers = pairedHostStatuses({ new: ['bots.home-pin.v1'], old: [] })

function hostHome(hostId: string): void {
  owner.hostId = hostId
  state.unifiedTabsByWorktree['folder:bot-home'][0].executionHostId = hostId
}

beforeEach(() => hostHome('local'))

describe("a bot's Home Chat banner", () => {
  it('offers the banner only on the Home tab of an agent whose host keeps the Home rule', () => {
    renderHeader('folder:bot-home', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).not.toBeNull()
    cleanup()
    renderHeader('folder:bot-home', 'side')
    renderHeader('folder:project', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
    cleanup()
    hostHome('runtime:new')
    renderHeader('folder:bot-home', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).not.toBeNull()
    cleanup()
    hostHome('runtime:old')
    renderHeader('folder:bot-home', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
  })
})
