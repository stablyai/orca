import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from './global-settings-types'
import {
  buildTuiAgentRoster,
  haveSameDisabledTuiAgents,
  normalizeDisabledTuiAgents,
  pickTuiAgent,
  TUI_AGENT_AUTO_PICK_ORDER
} from './tui-agent-selection'

describe('pickTuiAgent', () => {
  it('uses an installed preferred agent', () => {
    expect(pickTuiAgent('codex', ['claude', 'codex'])).toBe('codex')
  })

  it('falls back in desktop catalog order when the preference is absent or stale', () => {
    expect(pickTuiAgent(null, ['cursor', 'codex'])).toBe('codex')
    expect(pickTuiAgent('gemini', ['cursor', 'codex'])).toBe('codex')
    expect(pickTuiAgent(null, ['continue', 'command-code'])).toBe('command-code')
  })

  it('respects the explicit blank terminal preference', () => {
    expect(pickTuiAgent('blank', ['cursor', 'claude'])).toBeNull()
  })

  it('ignores disabled preferred and fallback agents', () => {
    expect(pickTuiAgent('codex', ['claude', 'codex'], ['codex'])).toBe('claude')
    expect(pickTuiAgent(null, ['claude', 'codex'], ['claude', 'codex'])).toBeNull()
  })
})

describe('buildTuiAgentRoster', () => {
  it('orders enabled and disabled agents by the desktop catalog', () => {
    const roster = buildTuiAgentRoster({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: ['codex', 'claude']
    })

    expect(roster).toEqual({
      enabled: TUI_AGENT_AUTO_PICK_ORDER.filter((agent) => agent !== 'claude' && agent !== 'codex'),
      disabled: ['claude', 'codex'],
      default: 'codex'
    })
  })

  it('maps blank and absent defaults to null', () => {
    expect(
      buildTuiAgentRoster({ defaultTuiAgent: 'blank', disabledTuiAgents: [] }).default
    ).toBeNull()
    expect(buildTuiAgentRoster({ defaultTuiAgent: null, disabledTuiAgents: [] }).default).toBeNull()
    expect(
      buildTuiAgentRoster({
        defaultTuiAgent: 'not-an-agent',
        disabledTuiAgents: []
      } as unknown as Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'>).default
    ).toBeNull()
  })
})

describe('normalizeDisabledTuiAgents', () => {
  it('dedupes supported agent ids and drops unsupported values', () => {
    expect(normalizeDisabledTuiAgents(['codex', 'unknown', 'codex', null, 'claude'])).toEqual([
      'codex',
      'claude'
    ])
  })
})

describe('haveSameDisabledTuiAgents', () => {
  it('compares the normalized disabled-agent sets', () => {
    expect(haveSameDisabledTuiAgents(['codex', 'claude'], ['claude', 'codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex', 'unknown'], ['codex'])).toBe(true)
    expect(haveSameDisabledTuiAgents(['codex'], ['claude'])).toBe(false)
  })
})
