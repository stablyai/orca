import { describe, expect, it } from 'vitest'
import { ACCOUNT_SWITCH_AGENTS } from './agent-account-switch-agents'

describe('ACCOUNT_SWITCH_AGENTS', () => {
  it('registers each agent under the id its queued restarts carry, with its own setting', () => {
    const agents = Object.entries(ACCOUNT_SWITCH_AGENTS)
    for (const [id, agent] of agents) {
      expect(agent.agent).toBe(id)
    }
    expect(new Set(agents.map(([, agent]) => agent.settingKey)).size).toBe(agents.length)
  })

  it.each([
    ['claude', '2.1.258', false],
    ['claude', 'claude', true],
    ['codex', 'codex.exe', true],
    ['codex', 'codex-aarch64-ap', true],
    ['codex', 'zsh', false]
  ] as const)('reads %s holding the pane from a %s foreground: %s', (id, process, holding) => {
    expect(
      ACCOUNT_SWITCH_AGENTS[id].isAgentForeground(
        { foregroundProcess: process, hasChildProcesses: true },
        id
      )
    ).toBe(holding)
  })
})
