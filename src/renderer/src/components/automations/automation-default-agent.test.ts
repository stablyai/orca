import { describe, expect, it } from 'vitest'
import { resolveDefaultAutomationAgent } from './automation-default-agent'

describe('resolveDefaultAutomationAgent', () => {
  it('falls back when a custom default agent is disabled', () => {
    const result = resolveDefaultAutomationAgent({
      defaultTuiAgent: 'custom:forge',
      disabledTuiAgents: [],
      customAgents: [
        {
          id: 'custom:forge',
          name: 'Forge',
          command: 'forge',
          enabled: false,
          promptMode: 'pty',
          icon: { kind: 'terminal' }
        }
      ],
      fallback: 'claude'
    })
    expect(result).toBe('claude')
  })

  it('falls back when a custom default agent no longer exists', () => {
    const result = resolveDefaultAutomationAgent({
      defaultTuiAgent: 'custom:ghost',
      disabledTuiAgents: [],
      customAgents: [],
      fallback: 'claude'
    })
    expect(result).toBe('claude')
  })

  it('keeps an enabled custom default agent', () => {
    const result = resolveDefaultAutomationAgent({
      defaultTuiAgent: 'custom:forge',
      disabledTuiAgents: [],
      customAgents: [
        {
          id: 'custom:forge',
          name: 'Forge',
          command: 'forge',
          enabled: true,
          promptMode: 'pty',
          icon: { kind: 'terminal' }
        }
      ],
      fallback: 'claude'
    })
    expect(result).toBe('custom:forge')
  })

  it('falls back when a TUI default agent is disabled', () => {
    const result = resolveDefaultAutomationAgent({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['codex'],
      customAgents: undefined,
      fallback: 'claude'
    })
    expect(result).toBe('claude')
  })

  it('falls back for "blank" or missing default', () => {
    expect(
      resolveDefaultAutomationAgent({
        defaultTuiAgent: 'blank',
        disabledTuiAgents: [],
        customAgents: undefined,
        fallback: 'claude'
      })
    ).toBe('claude')
    expect(
      resolveDefaultAutomationAgent({
        defaultTuiAgent: null,
        disabledTuiAgents: [],
        customAgents: undefined,
        fallback: 'claude'
      })
    ).toBe('claude')
  })
})
