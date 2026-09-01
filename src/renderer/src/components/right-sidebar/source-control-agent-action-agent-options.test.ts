import { describe, expect, it } from 'vitest'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import { buildSourceControlAgentActionOptions } from './source-control-agent-action-agent-options'

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

describe('buildSourceControlAgentActionOptions', () => {
  it('offers named custom agents alongside the detected built-ins', () => {
    const options = buildSourceControlAgentActionOptions({
      enabledDetectedAgents: ['claude', 'codex'],
      disabledAgents: [],
      localAgentCatalog: snapshot(),
      selectedAgent: null
    })

    expect(options.map((option) => option.id)).toEqual(['claude', 'codex', CUSTOM_CODEX])
    expect(options.at(-1)).toMatchObject({ label: 'Model-specific Codex', baseAgent: 'codex' })
  })

  it('drops a disabled custom agent from the picker', () => {
    const options = buildSourceControlAgentActionOptions({
      enabledDetectedAgents: ['codex'],
      disabledAgents: [CUSTOM_CODEX],
      localAgentCatalog: snapshot(),
      selectedAgent: null
    })

    expect(options.map((option) => option.id)).toEqual(['codex'])
  })

  it('keeps a saved custom selection listed with its real label when it is unavailable', () => {
    const options = buildSourceControlAgentActionOptions({
      enabledDetectedAgents: ['claude'],
      disabledAgents: [CUSTOM_CODEX],
      localAgentCatalog: snapshot(),
      selectedAgent: CUSTOM_CODEX
    })

    expect(options.map((option) => option.id)).toEqual(['claude', CUSTOM_CODEX])
    expect(options.at(-1)?.label).toBe('Model-specific Codex')
  })

  it('keeps listing an undetected built-in selection', () => {
    const options = buildSourceControlAgentActionOptions({
      enabledDetectedAgents: ['claude'],
      disabledAgents: undefined,
      localAgentCatalog: null,
      selectedAgent: 'cursor' as TuiAgent
    })

    expect(options.map((option) => option.id)).toEqual(['claude', 'cursor'])
  })
})
