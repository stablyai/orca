import { describe, expect, it, vi } from 'vitest'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId } from '../../../shared/types'
import {
  loadDirectLaunchAgentCatalog,
  resolveDirectLaunchAgent
} from './launch-work-item-direct-agent-selection'

const CUSTOM_CODEX = 'custom-agent:codex:11111111-1111-4111-8111-111111111111' as CustomTuiAgentId

function readyCustom(): LocalCustomTuiAgent {
  return {
    status: 'ready',
    definition: {
      id: CUSTOM_CODEX,
      baseAgent: 'codex',
      label: 'Model-specific Codex',
      args: '--model custom-model',
      syncEnv: false,
      commandOverride: '/opt/bin/codex'
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason: 'configured-executable'
  }
}

function snapshot(): LocalAgentCatalogSnapshot {
  return { customAgents: [readyCustom()] } as LocalAgentCatalogSnapshot
}

describe('resolveDirectLaunchAgent', () => {
  it('accepts a custom agent override that base detection never reports', () => {
    expect(
      resolveDirectLaunchAgent({
        agentOverride: CUSTOM_CODEX,
        detectedAgents: ['claude'],
        localAgentCatalog: snapshot(),
        settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [] }
      })
    ).toEqual({ requestedAgent: CUSTOM_CODEX, agentOverrideUnavailable: false })
  })

  it('launches a custom default instead of falling back to a built-in', () => {
    expect(
      resolveDirectLaunchAgent({
        detectedAgents: ['claude', 'codex'],
        localAgentCatalog: snapshot(),
        settings: { defaultTuiAgent: CUSTOM_CODEX, disabledTuiAgents: [] }
      })
    ).toEqual({ requestedAgent: CUSTOM_CODEX, agentOverrideUnavailable: false })
  })

  it('reports a disabled custom override as unavailable rather than launching another agent', () => {
    expect(
      resolveDirectLaunchAgent({
        agentOverride: CUSTOM_CODEX,
        detectedAgents: ['claude'],
        localAgentCatalog: snapshot(),
        settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [CUSTOM_CODEX] }
      })
    ).toEqual({ requestedAgent: null, agentOverrideUnavailable: true })
  })

  it('keeps built-in detection gating for built-in overrides and defaults', () => {
    expect(
      resolveDirectLaunchAgent({
        agentOverride: 'cursor',
        detectedAgents: ['claude'],
        localAgentCatalog: null,
        settings: { defaultTuiAgent: 'claude', disabledTuiAgents: [] }
      })
    ).toEqual({ requestedAgent: null, agentOverrideUnavailable: true })
    expect(
      resolveDirectLaunchAgent({
        detectedAgents: ['claude'],
        localAgentCatalog: null,
        settings: { defaultTuiAgent: 'cursor', disabledTuiAgents: [] }
      })
    ).toEqual({ requestedAgent: 'claude', agentOverrideUnavailable: false })
  })
})

describe('loadDirectLaunchAgentCatalog', () => {
  it('degrades to the built-in catalog when the local surface is unavailable', async () => {
    vi.stubGlobal('window', {
      api: { settings: { agentCatalog: { getLocal: vi.fn().mockRejectedValue(new Error('web')) } } }
    })
    await expect(loadDirectLaunchAgentCatalog()).resolves.toBeNull()

    vi.stubGlobal('window', {})
    await expect(loadDirectLaunchAgentCatalog()).resolves.toBeNull()
    vi.unstubAllGlobals()
  })
})
