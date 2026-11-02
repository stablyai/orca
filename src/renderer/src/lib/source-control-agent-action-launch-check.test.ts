import { describe, expect, it } from 'vitest'
import { checkSourceControlAgentActionLaunch } from './source-control-agent-action-launch-check'

const BASE = {
  agent: 'codex',
  commandInput: 'Fix checks',
  detectedAgents: ['codex'],
  platform: 'linux'
} as const

describe('checkSourceControlAgentActionLaunch', () => {
  it('rejects agents not detected on the current host', () => {
    expect(
      checkSourceControlAgentActionLaunch({ ...BASE, agent: 'claude', detectedAgents: ['codex'] })
    ).toEqual({ ok: false, error: 'The selected agent was not detected on this workspace host.' })
  })

  it('rejects invalid per-action CLI arguments', () => {
    expect(
      checkSourceControlAgentActionLaunch({
        ...BASE,
        detectedAgents: ['codex'],
        agentArgs: '--model "unterminated'
      })
    ).toEqual({
      ok: false,
      error: 'CLI arguments are invalid: Unclosed quote in command template.'
    })
  })
})
