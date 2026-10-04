import { describe, expect, it } from 'vitest'
import { defaultAgentChatLabel } from './agent-session-chat-label'

describe('initial structured chat titles', () => {
  it.each([
    { agent: 'dsh-acp', title: 'DeepSeek Harness (Official ACP) Chat' },
    { agent: 'dsh', title: 'DeepSeek Harness Chat' },
    { agent: 'claude', title: 'Claude Chat' },
    { agent: 'codex', title: 'Codex Chat' }
  ] as const)('identifies $agent through the shared chat-label caller', ({ agent, title }) => {
    expect(defaultAgentChatLabel(agent)).toBe(title)
  })
})
