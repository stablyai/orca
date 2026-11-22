import { describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn(async () => true))
const groups = vi.hoisted(() => ({ listed: false, refresh: vi.fn(async () => {}) }))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: open
}))
vi.mock('@/lib/bot-group-catalog', () => ({ BotGroupRoomUnavailableError: class extends Error {} }))
vi.mock('@/lib/bot-group-catalog-snapshot', () => ({
  hasListedLocalBotGroups: () => groups.listed
}))
vi.mock('@/lib/bot-group-list', () => ({ refreshBotHostGroups: groups.refresh }))

import { navigateResourceSessionToTab, openResourceChat } from './resource-session-navigation'

describe('opening a chat row', () => {
  it('reads the group list first when it was never read, so a group member opens its room', async () => {
    groups.refresh.mockImplementationOnce(async () => {
      expect(open).not.toHaveBeenCalled()
      groups.listed = true
    })
    await openResourceChat('repo::/w1', 'chat-1')

    expect(groups.refresh).toHaveBeenCalledWith('local')
    expect(open).toHaveBeenCalledWith(
      { structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-1' } },
      undefined,
      { kind: 'local' }
    )
  })

  it("opens a paired machine's chat on that machine", async () => {
    await openResourceChat('repo::/w1', 'chat-2', 'runtime:studio')

    expect(groups.refresh).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenLastCalledWith(
      { structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-2' } },
      undefined,
      { kind: 'environment', environmentId: 'studio' }
    )
  })
})

describe('opening a terminal row', () => {
  const kept = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
  const removed = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'

  it('focuses the pane only when its tab still has it', () => {
    const activate = vi.fn()
    const deps = {
      tabsByWorktree: { 'repo::/w1': [{ id: 'tab-1' }] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf' as const, leafId: kept },
          activeLeafId: kept,
          expandedLeafId: null
        }
      },
      setActiveView: vi.fn(),
      activateAndRevealWorktree: vi.fn(),
      activateTabAndFocusPane: activate
    }
    navigateResourceSessionToTab('tab-1', `tab-1:${kept}`, deps)
    navigateResourceSessionToTab('tab-1', `tab-1:${removed}`, deps)

    expect(activate.mock.calls.map((call) => call[1])).toEqual([kept, null])
  })
})
