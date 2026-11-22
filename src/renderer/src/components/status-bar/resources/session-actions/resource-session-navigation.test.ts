import { describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn(async () => true))
const groupsListed = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: open
}))
vi.mock('@/lib/bot-group-catalog', () => ({ BotGroupRoomUnavailableError: class extends Error {} }))
vi.mock('@/lib/bot-group-list', () => ({ whenLocalBotGroupsListed: groupsListed }))

import { navigateResourceSessionToTab, openResourceChat } from './resource-session-navigation'

describe('opening a chat row', () => {
  it('opens an ordinary chat as a history click does, without reading the group list', async () => {
    await openResourceChat('repo::/w1', 'chat-1')

    expect(groupsListed).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith(
      { structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-1' } },
      undefined,
      { kind: 'local' }
    )
  })

  it("waits for the group list before opening a group member, so it opens the member's room", async () => {
    groupsListed.mockImplementationOnce(async () => {
      expect(open).toHaveBeenCalledTimes(1)
    })
    await openResourceChat('home::/bots', 'bot-group-member-a')

    expect(groupsListed).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenLastCalledWith(
      { structuredSession: { workspaceId: 'home::/bots', sessionId: 'bot-group-member-a' } },
      undefined,
      { kind: 'local' }
    )
  })

  it("opens a paired machine's chat on that machine", async () => {
    await openResourceChat('repo::/w1', 'chat-2', 'runtime:studio')

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
