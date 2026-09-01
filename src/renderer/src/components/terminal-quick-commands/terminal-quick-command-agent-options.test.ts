import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { supportsTerminalAgentQuickCommand } from '../../../../shared/terminal-quick-commands'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import {
  buildTerminalQuickCommandAgentOptions,
  getTerminalQuickCommandAgentOptions
} from './terminal-quick-command-agent-options'

// A canonical custom id (custom-agent:<base>:<uuid>) — supportsTerminalAgentQuickCommand
// validates the id syntax, so the uuid segment must be well-formed.
const CUSTOM = 'custom-agent:codex:0f1e2d3c-5e6f-4a7b-8c9d-0e1f2a3b4c5d' as CustomTuiAgentId

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

describe('terminal quick command agent options', () => {
  it('does not inherit OpenClaude as the second quick-command agent option', () => {
    const ids = getTerminalQuickCommandAgentOptions().map((entry) => entry.id)

    expect(ids.slice(0, 3)).toEqual(['claude', 'codex', 'gemini'])
    expect(ids.indexOf('openclaude')).toBeGreaterThan(ids.indexOf('command-code'))
  })

  it('keeps unsupported prompt-command agents below supported agents', () => {
    const ids = getTerminalQuickCommandAgentOptions().map((entry) => entry.id)
    const firstUnsupportedIndex = ids.findIndex((id) => !supportsTerminalAgentQuickCommand(id))
    const lastSupportedIndex = ids.reduce(
      (lastIndex, id, index) => (supportsTerminalAgentQuickCommand(id) ? index : lastIndex),
      -1
    )

    expect(firstUnsupportedIndex).toBeGreaterThan(-1)
    expect(lastSupportedIndex).toBeLessThan(firstUnsupportedIndex)
  })

  it('keeps the same agent set as the global catalog', () => {
    expect(new Set(getTerminalQuickCommandAgentOptions().map((entry) => entry.id))).toEqual(
      new Set(AGENT_CATALOG.map((entry) => entry.id))
    )
  })
})

describe('buildTerminalQuickCommandAgentOptions', () => {
  it('offers a ready custom agent as a supported, selectable option with the base icon + human label', () => {
    const options = buildTerminalQuickCommandAgentOptions(
      'claude',
      [],
      snapshot([readyCustom('/opt/agent')])
    )
    const custom = options.find((entry) => entry.id === CUSTOM)
    expect(custom).toMatchObject({ label: 'My Codex', baseAgent: 'codex', cmd: '/opt/agent' })
    // Quick commands validate base capability at launch, so a custom is supported.
    expect(supportsTerminalAgentQuickCommand(CUSTOM)).toBe(true)
  })

  it('hides a disabled custom that is not the current selection', () => {
    const options = buildTerminalQuickCommandAgentOptions(
      'claude',
      [CUSTOM],
      snapshot([readyCustom()])
    )
    expect(options.some((entry) => entry.id === CUSTOM)).toBe(false)
  })

  it('keeps the selected custom visible with its real label even when disabled (draft-keep)', () => {
    const options = buildTerminalQuickCommandAgentOptions(
      CUSTOM,
      [CUSTOM],
      snapshot([readyCustom()])
    )
    const kept = options.find((entry) => entry.id === CUSTOM)
    expect(kept).toMatchObject({ label: 'My Codex', baseAgent: 'codex' })
  })

  it('never surfaces a raw custom-agent id as a label and preserves the built-in set', () => {
    const options = buildTerminalQuickCommandAgentOptions(
      CUSTOM as TuiAgent,
      [],
      snapshot([readyCustom('/opt/agent')])
    )
    for (const entry of options) {
      expect(entry.label.startsWith('custom-agent:')).toBe(false)
    }
    for (const builtIn of AGENT_CATALOG) {
      expect(options.some((entry) => entry.id === builtIn.id)).toBe(true)
    }
  })
})
