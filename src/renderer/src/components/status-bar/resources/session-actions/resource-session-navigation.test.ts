import { describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: open
}))
vi.mock('@/lib/bot-group-catalog', () => ({ BotGroupRoomUnavailableError: class extends Error {} }))

import { openResourceChat } from './resource-session-navigation'

describe('opening a chat row', () => {
  it('opens a local chat as a history click does, on this machine even if a paired twin is selected', () => {
    openResourceChat('repo::/w1', 'chat-1')

    expect(open).toHaveBeenCalledWith(
      { structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-1' } },
      undefined,
      { kind: 'local' }
    )
  })

  it("opens a paired machine's chat on that machine", () => {
    openResourceChat('repo::/w1', 'chat-2', 'runtime:studio')

    expect(open).toHaveBeenLastCalledWith(
      { structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-2' } },
      undefined,
      { kind: 'environment', environmentId: 'studio' }
    )
  })
})
