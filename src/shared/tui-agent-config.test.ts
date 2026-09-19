import { describe, expect, it } from 'vitest'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

describe('TUI_AGENT_CONFIG', () => {
  it('resolves launchCmd and expectedProcess for every agent', () => {
    for (const [agent, config] of Object.entries(TUI_AGENT_CONFIG)) {
      expect(config.launchCmd, agent).toBeTruthy()
      expect(config.expectedProcess, agent).toBeTruthy()
    }
  })

  it('defaults launchCmd and expectedProcess to detectCmd', () => {
    expect(TUI_AGENT_CONFIG.codex).toMatchObject({
      detectCmd: 'codex',
      launchCmd: 'codex',
      expectedProcess: 'codex'
    })
  })

  it('maps Gajae Code detection onto both gjc and gajae-code', () => {
    expect(TUI_AGENT_CONFIG['gajae-code']).toMatchObject({
      detectCmd: 'gjc',
      detectCmdAliases: ['gajae-code'],
      launchCmd: 'gjc',
      expectedProcess: 'gjc',
      promptInjectionMode: 'stdin-after-start',
      draftPasteReadySignal: 'render-cursor-after-bracketed-paste'
    })
    expect(getTuiAgentDetectCommands(TUI_AGENT_CONFIG['gajae-code'])).toEqual(['gjc', 'gajae-code'])
  })

  it('keeps explicit overrides where the launch line or process differs from the binary', () => {
    const overrides: Partial<Record<TuiAgent, Partial<(typeof TUI_AGENT_CONFIG)[TuiAgent]>>> = {
      'claude-agent-teams': { launchCmd: 'orca claude-teams', expectedProcess: 'claude' },
      kiro: { launchCmd: 'kiro-cli chat --tui', expectedProcess: 'kiro-cli' },
      'command-code': { launchCmd: 'command-code --trust' },
      hermes: { launchCmd: 'hermes --tui' }
    }
    for (const [agent, expected] of Object.entries(overrides)) {
      expect(TUI_AGENT_CONFIG[agent as TuiAgent]).toMatchObject(expected)
    }
  })
})
