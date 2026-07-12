import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { deriveNativeChatStatusFooter } from './native-chat-status-footer'

function assistant(text: string): NativeChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }]
  }
}

function status(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    paneKey: 'tab:leaf',
    agentType: 'codex',
    ...overrides
  }
}

describe('deriveNativeChatStatusFooter', () => {
  it('formats provider metadata, repository state, and the latest stage footer', () => {
    const result = deriveNativeChatStatusFooter({
      agent: 'codex',
      metadata: {
        model: 'gpt-5.6-sol',
        reasoningEffort: 'xhigh',
        contextTokens: 77_000,
        contextWindowTokens: 1_000_000,
        sessionLimitUsedPercent: 14,
        weeklyLimitUsedPercent: 5
      },
      messages: [
        assistant('Промежуточный статус.\nэтап: разведка → спека в issue #156 · Q:1 B:0 Ag:2')
      ],
      worktreeName: 'leo-corp',
      changedFiles: 3,
      agentStatus: status()
    })

    expect(result.primary).toEqual([
      'gpt-5.6-sol',
      'xhigh',
      '77k/1M',
      'leo-corp +3',
      '5h 14%',
      '7d 5%'
    ])
    expect(result.stage).toBe('разведка')
    expect(result.next).toBe('спека в issue #156')
    expect(result.questions).toBe(1)
    expect(result.blocked).toBe(0)
    expect(result.agents).toBe(2)
  })

  it('uses live hook facts ahead of stale counts in the assistant footer', () => {
    const result = deriveNativeChatStatusFooter({
      agent: 'codex',
      messages: [assistant('этап: работа → проверка · вопросов 0 · blocked 0 · Ag:0')],
      agentStatus: status({
        state: 'blocked',
        interactivePrompt: JSON.stringify({
          questions: [{ question: 'Merge?' }, { question: 'Ship?' }]
        }),
        subagents: [
          { id: 'a', state: 'working', startedAt: 1 },
          { id: 'b', state: 'idle', startedAt: 1 }
        ]
      })
    })

    expect(result.questions).toBe(2)
    expect(result.blocked).toBe(1)
    expect(result.agents).toBe(1)
  })

  it('falls back to the live agent state before the first explicit stage line', () => {
    const result = deriveNativeChatStatusFooter({
      agent: 'codex',
      messages: [],
      agentStatus: status({ state: 'working' })
    })

    expect(result.stage).toBe('working')
    expect(result.next).toBe('next agent update')
  })

  it('uses the working fallback before agent status is available', () => {
    const result = deriveNativeChatStatusFooter({
      agent: 'codex',
      messages: []
    })

    expect(result.stage).toBe('working')
    expect(result.next).toBe('next agent update')
  })
})
