import { describe, expect, it } from 'vitest'
import type { AgentHealthSnapshot } from '../../../../shared/agent-health'
import type { AgentProviderReadiness } from './agent-readiness'
import {
  getOverallAgentConnectionState,
  getProviderConnectionState
} from './agent-health-presentation'

const readyProvider: AgentProviderReadiness = {
  provider: 'codex',
  installed: true,
  linkedAccountCount: 0,
  state: 'ready',
  reason: 'ready',
  activeAccount: null,
  accounts: []
}

function snapshot(overrides: Partial<AgentHealthSnapshot> = {}): AgentHealthSnapshot {
  return {
    provider: 'codex',
    cliStatus: 'available',
    health: 'healthy',
    version: '0.146.1',
    durationMs: 10,
    checkedAt: 1,
    checks: [{ id: 'cli', status: 'ok' }],
    ...overrides
  }
}

describe('agent health presentation', () => {
  it('promotes authentication failures to action required', () => {
    expect(
      getProviderConnectionState(
        readyProvider,
        snapshot({
          health: 'unhealthy',
          checks: [{ id: 'authentication', status: 'failed' }]
        }),
        false
      )
    ).toBe('action-required')
  })

  it.each(['provider', 'websocket'] as const)('surfaces %s failures as degraded', (checkId) => {
    expect(
      getProviderConnectionState(
        readyProvider,
        snapshot({
          health: 'unhealthy',
          checks: [{ id: checkId, status: 'failed' }]
        }),
        false
      )
    ).toBe('degraded')
  })

  it('keeps account readiness failures even when the CLI probe is healthy', () => {
    expect(
      getProviderConnectionState(
        { ...readyProvider, state: 'action-required', reason: 'sign-in-required' },
        snapshot(),
        false
      )
    ).toBe('action-required')
  })

  it('keeps readiness status when an older runtime has no health probe', () => {
    expect(getProviderConnectionState(readyProvider, null, false)).toBe('ready')
  })

  it('keeps a completed provider ready while another provider is pending', () => {
    const claudeProvider: AgentProviderReadiness = {
      ...readyProvider,
      provider: 'claude'
    }

    expect(
      getOverallAgentConnectionState([readyProvider, claudeProvider], [snapshot()], {
        claude: true,
        codex: false
      })
    ).toBe('checking')
    expect(getProviderConnectionState(readyProvider, snapshot(), false)).toBe('ready')
  })
})
