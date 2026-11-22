// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createTestStore } from '../../store/testing/app-store-test-fixture'
import { createTabsSliceMockApi } from '../../store/slices/tabs/tabs-slice-test-harness'
import { BotHomeChat } from './BotHomeChat'

const model = vi.hoisted(
  (): {
    store: ReturnType<typeof createTestStore> | null
    bot: {
      id: string
      hostId: string
      folderWorkspaceId: string
      chatSessionId: string
      agent: string
    }
    resolvedSessionId: string
  } => ({
    store: null,
    bot: {
      id: 'bot-1',
      hostId: 'local',
      folderWorkspaceId: 'bot-home',
      chatSessionId: 'home',
      agent: 'claude'
    },
    resolvedSessionId: 'home'
  })
)

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', () => ({
  get useAppStore() {
    return model.store
  }
}))
vi.mock('@/lib/bot-catalog', () => ({
  readBots: () => [model.bot],
  readBotsEnabled: () => true,
  useBots: () => [model.bot],
  useBotsEnabled: () => true,
  openBotChat: async () => {
    model.store!.getState().createUnifiedTab('folder:bot-home', 'agent-session', {
      id: `tab-${model.resolvedSessionId}`,
      entityId: model.resolvedSessionId,
      executionHostId: 'local',
      agentSessionAgent: 'claude',
      activate: false
    })
    return model.resolvedSessionId
  }
}))

createTabsSliceMockApi()

beforeEach(() => {
  model.store = createTestStore()
  model.bot = { ...model.bot, hostId: 'local', chatSessionId: 'home' }
  model.resolvedSessionId = 'home'
})
afterEach(cleanup)

it('opens on readiness, then re-resolves a rotated Home and repairs a later missing tab', async () => {
  const view = render(<BotHomeChat workspaceId="folder:bot-home" />)
  expect(model.store!.getState().unifiedTabsByWorktree['folder:bot-home'] ?? []).toEqual([])
  await act(async () => model.store!.setState({ workspaceSessionReady: true }))
  expect(model.store!.getState().getTab('tab-home')?.entityId).toBe('home')

  model.bot = { ...model.bot, chatSessionId: 'next-home' }
  model.resolvedSessionId = 'next-home'
  await act(async () => view.rerender(<BotHomeChat workspaceId="folder:bot-home" />))
  expect(model.store!.getState().getTab('tab-next-home')?.entityId).toBe('next-home')

  // A later inventory can omit a tab while its host still retains the conversation.
  await act(async () =>
    model.store!.setState((state) => ({
      unifiedTabsByWorktree: {
        'folder:bot-home': state.unifiedTabsByWorktree['folder:bot-home']!.filter(
          (tab) => tab.entityId !== 'next-home'
        )
      }
    }))
  )
  expect(model.store!.getState().getTab('tab-next-home')?.entityId).toBe('next-home')
})
