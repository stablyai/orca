import { describe, expect, it, vi } from 'vitest'

const open = vi.hoisted(() => vi.fn(async () => ({ kind: 'opened' })))
vi.mock('@/lib/agent-session/open/activate-ai-vault-structured-session', () => ({
  openDesktopStructuredSession: open
}))

import { openResourceChat } from './resource-session-navigation'

describe('opening a chat row', () => {
  it('goes through the chat open path, which reveals a background chat that has no tab', () => {
    openResourceChat('repo::/w1', 'chat-1')

    expect(open).toHaveBeenCalledWith({
      kind: 'history',
      structuredSession: { workspaceId: 'repo::/w1', sessionId: 'chat-1' }
    })
  })
})
