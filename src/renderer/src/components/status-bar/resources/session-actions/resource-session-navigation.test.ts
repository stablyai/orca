import { describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn(async () => true))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: open
}))

import { openResourceChat } from './resource-session-navigation'

describe('opening a chat row', () => {
  it("opens it as a history click does, which reveals a tabless chat and a group member's room", () => {
    openResourceChat('repo::/w1', 'chat-1')

    expect(open).toHaveBeenCalledWith({
      structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-1' }
    })
  })
})
