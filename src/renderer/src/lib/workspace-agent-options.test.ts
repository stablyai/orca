import { describe, expect, it } from 'vitest'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../shared/types'
import { buildWorkspaceAgentOptions } from './workspace-agent-options'

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

describe('buildWorkspaceAgentOptions', () => {
  it('includes the exact ready custom identity even when its base is not detected', () => {
    const options = buildWorkspaceAgentOptions({
      detectedAgentIds: new Set<TuiAgent>(['claude']),
      disabledTuiAgents: [],
      localAgentCatalog: snapshot()
    })

    expect(options.map((option) => option.id)).toEqual(['claude', CUSTOM_CODEX])
    expect(options.at(-1)).toMatchObject({
      id: CUSTOM_CODEX,
      label: 'Model-specific Codex',
      baseAgent: 'codex',
      cmd: '/opt/bin/codex'
    })
  })

  it('removes a custom identity when it or its base is disabled', () => {
    for (const disabledTuiAgents of [[CUSTOM_CODEX], ['codex']] as TuiAgent[][]) {
      const options = buildWorkspaceAgentOptions({
        detectedAgentIds: new Set<TuiAgent>(['claude', 'codex']),
        disabledTuiAgents,
        localAgentCatalog: snapshot()
      })

      expect(options.some((option) => option.id === CUSTOM_CODEX)).toBe(false)
    }
  })
})
