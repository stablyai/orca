import { describe, expect, it } from 'vitest'
import { resolveNativeChatTabAgentEvidence } from './native-chat-tab-agent-evidence'

describe('resolveNativeChatTabAgentEvidence', () => {
  it('uses the retained provider identity when a generated title masks the process title', () => {
    expect(
      resolveNativeChatTabAgentEvidence(
        {
          title: 'Summarize recent commits',
          aiVaultTitle: null
        },
        {
          label: 'Summarize recent commits',
          aiVaultTitle: {
            agent: 'codex',
            sessionId: 'thread-1',
            title: 'Summarize recent commits'
          }
        }
      )
    ).toBe('codex')
  })

  it('keeps the committed process-title signal ahead of retained metadata', () => {
    expect(
      resolveNativeChatTabAgentEvidence(
        {
          title: 'Claude Code',
          aiVaultTitle: { agent: 'codex', sessionId: 'thread-1', title: 'Old title' }
        },
        {
          label: 'Old title',
          aiVaultTitle: null
        }
      )
    ).toBe('claude')
  })
})
