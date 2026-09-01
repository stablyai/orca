import { describe, expect, it } from 'vitest'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId } from '../../../../shared/types'
import { getAgentCatalogForAction } from './source-control-action-recipe-options'

const CUSTOM = 'custom-agent:codex:33333333-3333-4333-8333-333333333333' as CustomTuiAgentId

function snapshot(): LocalAgentCatalogSnapshot {
  const custom: LocalCustomTuiAgent = {
    status: 'ready',
    definition: {
      id: CUSTOM,
      baseAgent: 'codex',
      label: 'My Codex',
      args: '',
      syncEnv: false,
      commandOverride: '/opt/agent'
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason: 'configured-executable'
  }
  return { customAgents: [custom] } as unknown as LocalAgentCatalogSnapshot
}

describe('getAgentCatalogForAction', () => {
  it('offers custom agents for launch actions', () => {
    const options = getAgentCatalogForAction('resolveConflicts', null, snapshot())
    expect(options.find((entry) => entry.id === CUSTOM)).toMatchObject({
      label: 'My Codex',
      baseAgent: 'codex'
    })
  })

  it('keeps text-generation actions custom-free', () => {
    const options = getAgentCatalogForAction('commitMessage', null, snapshot())
    expect(options.some((entry) => entry.id === CUSTOM)).toBe(false)
  })

  it('still lists built-ins for launch actions without a snapshot', () => {
    const options = getAgentCatalogForAction('resolveConflicts', null, null)
    expect(options.some((entry) => entry.id === 'codex')).toBe(true)
  })
})
