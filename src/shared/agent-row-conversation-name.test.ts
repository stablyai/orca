import { describe, expect, it } from 'vitest'
import {
  getAgentRowConversationName,
  type ConversationNameTab
} from './agent-row-conversation-name'

function makeTab(overrides: Partial<ConversationNameTab> = {}): ConversationNameTab {
  return { customTitle: null, title: '', ...overrides }
}

describe('getAgentRowConversationName', () => {
  it("shows the title owned by the row's provider session", () => {
    const tab = makeTab({
      aiVaultTitle: { agent: 'claude', sessionId: 's1', title: 'Fix the lease probe' },
      generatedTitle: 'Fix intake flow',
      title: '\u2733 Investigate replay bug'
    })
    expect(getAgentRowConversationName(tab, 'claude', true, undefined, 's1')).toBe(
      'Fix the lease probe'
    )
    expect(getAgentRowConversationName(tab, 'claude', true, undefined, 's2')).toBe(
      'Fix intake flow'
    )
    expect(getAgentRowConversationName(tab, 'codex', true, undefined, 's1')).toBe('Fix intake flow')
    expect(getAgentRowConversationName(tab, 'claude', true)).toBe('Fix intake flow')
  })

  it('keeps a cwd-shaped provider title that the live-title sanitizer would discard', () => {
    // `auth/login` is a real session name; as a scraped live title it would be read as a cwd.
    const tab = makeTab({
      aiVaultTitle: { agent: 'claude', sessionId: 's1', title: 'auth/login' },
      title: '\u2733 Investigate replay bug'
    })
    expect(getAgentRowConversationName(tab, 'claude', true, undefined, 's1')).toBe('auth/login')
    expect(getAgentRowConversationName(makeTab({ title: 'auth/login' }), 'claude', true)).toBeNull()
  })

  it('names a split pane from its own live title, not the tab title', () => {
    // Tab live title belongs to the focused pane; siblings need their own.
    const tab = makeTab({ title: '\u2733 Linear work log' })
    expect(getAgentRowConversationName(tab, 'claude', false, '\u2733 Redis cache strategy')).toBe(
      'Redis cache strategy'
    )
    expect(
      getAgentRowConversationName(tab, 'opencode', false, 'OC | build the release pipeline')
    ).toBe('OC | build the release pipeline')
    expect(getAgentRowConversationName(tab, 'claude', false, null)).toBeNull()
    expect(getAgentRowConversationName(tab, 'claude', false)).toBe('Linear work log')
  })
})
