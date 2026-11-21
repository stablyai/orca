// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'
import { pairedHostStatuses } from '@/lib/bot-host-capability.test-fixture'

const sidebar = vi.hoisted(() => ({ setRightSidebarTab: vi.fn(), setRightSidebarOpen: vi.fn() }))
const owner = vi.hoisted(() => ({ hostId: 'local' }))
const state = vi.hoisted(() => {
  const tab = {
    worktreeId: 'folder:bot-home',
    contentType: 'agent-session',
    executionHostId: 'local'
  }
  return {
    workspaceSessionReady: true,
    unifiedTabsByWorktree: {
      'folder:bot-home': [
        { ...tab, id: 'tab-home', entityId: 'home' },
        { ...tab, id: 'tab-side', entityId: 'side' }
      ]
    }
  }
})

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
vi.mock('../../../bots/bot-avatar-image', () => ({
  useBotAvatarLook: () => ({ src: null, outfit: null })
}))
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
  for (const tab of state.unifiedTabsByWorktree['folder:bot-home']) {
    tab.executionHostId = hostId
  }
}

beforeEach(() => hostHome('local'))

describe('a bot chat banner', () => {
  it('offers the bot page only in its own Home and side chats on supported hosts', () => {
    for (const [host, visible] of [
      ['local', true],
      ['runtime:new', true],
      ['runtime:old', false]
    ] as const) {
      hostHome(host)
      for (const sessionId of ['home', 'side']) {
        renderHeader('folder:bot-home', sessionId)
        expect(screen.queryByRole('button', { name: OPEN_PAGE }) !== null).toBe(visible)
        cleanup()
      }
    }
    hostHome('local')
    renderHeader('folder:project', 'home')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
    cleanup()
    owner.hostId = 'runtime:new'
    renderHeader('folder:bot-home', 'side')
    expect(screen.queryByRole('button', { name: OPEN_PAGE })).toBeNull()
  })
})
