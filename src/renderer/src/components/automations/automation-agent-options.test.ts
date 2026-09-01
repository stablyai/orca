import { describe, expect, it } from 'vitest'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import { buildAutomationAgentOptions } from './automation-agent-options'

const CUSTOM = 'custom-agent:codex:aaaa' as CustomTuiAgentId

function readyCustom(commandOverride?: string): LocalCustomTuiAgent {
  return {
    status: 'ready',
    definition: {
      id: CUSTOM,
      baseAgent: 'codex',
      label: 'My Codex',
      args: '',
      syncEnv: false,
      ...(commandOverride ? { commandOverride } : {})
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason: 'configured-executable'
  }
}

function snapshot(customAgents: LocalCustomTuiAgent[]): LocalAgentCatalogSnapshot {
  return { customAgents } as unknown as LocalAgentCatalogSnapshot
}

describe('buildAutomationAgentOptions', () => {
  it('offers a ready custom agent without detection gating', () => {
    const options = buildAutomationAgentOptions('codex', [], snapshot([readyCustom('/opt/agent')]))
    const custom = options.find((entry) => entry.id === CUSTOM)
    expect(custom).toMatchObject({ label: 'My Codex', baseAgent: 'codex', cmd: '/opt/agent' })
  })

  it('keeps a disabled custom assignment visible with its real label (draft-keep)', () => {
    // The custom is the draft's agent AND disabled: the built-in draft-keep can't
    // hold a custom id, so this proves the custom-specific keep surfaces the label.
    const options = buildAutomationAgentOptions('codex', [], snapshot([readyCustom()]))
    // Sanity: without disabling, it merges normally.
    expect(options.some((entry) => entry.id === CUSTOM)).toBe(true)

    const keptWhileDisabled = buildAutomationAgentOptions(
      CUSTOM,
      [CUSTOM],
      snapshot([readyCustom()])
    )
    const kept = keptWhileDisabled.find((entry) => entry.id === CUSTOM)
    expect(kept).toMatchObject({ label: 'My Codex', baseAgent: 'codex' })
  })

  it('hides a disabled custom that is not the current assignment', () => {
    const options = buildAutomationAgentOptions('codex', [CUSTOM], snapshot([readyCustom()]))
    expect(options.some((entry) => entry.id === CUSTOM)).toBe(false)
  })

  it('preserves the built-in draft-keep for a disabled built-in assignment', () => {
    const options = buildAutomationAgentOptions('codex', ['codex'], snapshot([]))
    expect(options.some((entry) => entry.id === 'codex')).toBe(true)
  })

  it('never surfaces a raw custom-agent id as a label', () => {
    const options = buildAutomationAgentOptions(
      CUSTOM as TuiAgent,
      [],
      snapshot([readyCustom('/opt/agent')])
    )
    for (const entry of options) {
      expect(entry.label.startsWith('custom-agent:')).toBe(false)
    }
  })
})
