import { describe, expect, it } from 'vitest'
import {
  buildTabAgentLaunchOptions,
  deriveTabCustomAgentEntries,
  findMatchingTabAgentLaunchOptions,
  orderTabLaunchAgents
} from './tab-agent-launch-options'

describe('tab agent launch options', () => {
  it('orders detected agents by the configured default first', () => {
    expect(orderTabLaunchAgents('codex', ['claude', 'codex', 'gemini'])).toEqual([
      'codex',
      'claude',
      'gemini'
    ])
  })

  it('excludes disabled agents from the launch list', () => {
    expect(
      orderTabLaunchAgents(null, ['claude', 'codex', 'openclaude'], [], ['openclaude'])
    ).toEqual(['claude', 'codex'])
  })

  it('drops a disabled default agent instead of surfacing it first', () => {
    const ordered = orderTabLaunchAgents(
      'openclaude',
      ['claude', 'codex', 'openclaude'],
      [],
      ['openclaude']
    )
    expect(ordered).not.toContain('openclaude')
    expect(ordered).toEqual(['claude', 'codex'])
  })

  it('keeps a disabled agent out of new-tab search results', () => {
    const options = buildTabAgentLaunchOptions(
      orderTabLaunchAgents('codex', ['claude', 'codex', 'openclaude'], [], ['openclaude'])
    )
    expect(findMatchingTabAgentLaunchOptions('open', options).map((o) => o.agent)).toEqual([])
  })

  it('matches detected agents by id, label, command, and command override', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'antigravity'], {
      codex: 'codex-beta'
    })

    expect(
      findMatchingTabAgentLaunchOptions('Claude', options).map((option) => option.agent)
    ).toEqual(['claude'])
    expect(findMatchingTabAgentLaunchOptions('openai codex', options)).toEqual([])
    expect(
      findMatchingTabAgentLaunchOptions('codex-beta', options).map((option) => option.agent)
    ).toEqual(['codex'])
    expect(findMatchingTabAgentLaunchOptions('agy', options).map((option) => option.agent)).toEqual(
      ['antigravity']
    )
  })

  it('matches agents on a partial prefix so the launcher actually searches', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'gemini', 'antigravity'])

    // Each is one character short of the full agent name.
    expect(findMatchingTabAgentLaunchOptions('gemin', options).map((o) => o.agent)).toEqual([
      'gemini'
    ])
    expect(findMatchingTabAgentLaunchOptions('clau', options).map((o) => o.agent)).toEqual([
      'claude'
    ])
    expect(findMatchingTabAgentLaunchOptions('anti', options).map((o) => o.agent)).toEqual([
      'antigravity'
    ])
  })

  it('ranks an exact alias above weaker prefix matches', () => {
    const options = buildTabAgentLaunchOptions(['codex', 'copilot', 'codebuff'])

    // "co" prefixes all three; "codex" exactly matches one and must lead.
    expect(findMatchingTabAgentLaunchOptions('codex', options)[0]?.agent).toBe('codex')
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot', 'codebuff'])
    )
  })

  it('does not match on a mid-string substring that would hijack file results', () => {
    const options = buildTabAgentLaunchOptions(['opencode', 'claude'])

    // "ode" is inside "opencode" but not a prefix — agents rank above files, so
    // a noisy mid-string hit must not surface.
    expect(findMatchingTabAgentLaunchOptions('ode', options)).toEqual([])
  })

  it('requires at least two characters before a prefix matches (no single-key flood)', () => {
    const options = buildTabAgentLaunchOptions(['claude', 'codex', 'copilot', 'cursor'])

    // A lone "c" must not surface (and auto-launch) an agent.
    expect(findMatchingTabAgentLaunchOptions('c', options)).toEqual([])
    // Two characters is enough to start searching.
    expect(findMatchingTabAgentLaunchOptions('co', options).map((o) => o.agent)).toEqual(
      expect.arrayContaining(['codex', 'copilot'])
    )
  })
})

describe('custom agents in the tab quick-launch list', () => {
  const CUSTOM_ID = 'custom-agent:codex:11111111-2222-4333-8444-555555555555' as never
  const customEntry = {
    id: CUSTOM_ID,
    baseAgent: 'codex' as const,
    label: 'Codex-5.6-sol-xhigh',
    commandOverride: undefined,
    requiresDetectedBase: true
  }

  it('groups a ready custom agent directly under its detected base', () => {
    const ordered = orderTabLaunchAgents(null, ['claude', 'codex'], [customEntry])
    const codexIndex = ordered.indexOf('codex')
    expect(ordered[codexIndex + 1]).toBe(CUSTOM_ID)
  })

  it('gates a baseline-stock custom on base detection but never gates a configured executable', () => {
    // Base not detected: the stock-PATH custom drops, the overridden one stays
    // (its availability is launch-reported, oracle 35).
    const stock = orderTabLaunchAgents(null, ['claude'], [customEntry])
    expect(stock).not.toContain(CUSTOM_ID)
    const overridden = orderTabLaunchAgents(
      null,
      ['claude'],
      [{ ...customEntry, commandOverride: '/opt/codex/bin/codex', requiresDetectedBase: false }]
    )
    expect(overridden).toContain(CUSTOM_ID)
  })

  it('hoists a custom agent first when it is the configured default', () => {
    const ordered = orderTabLaunchAgents(CUSTOM_ID, ['claude', 'codex'], [customEntry])
    expect(ordered[0]).toBe(CUSTOM_ID)
  })

  it('drops (never hoists) a baseline-stock custom default whose base is undetected', () => {
    // The default-first hoist must not resurrect a custom the detection gate
    // filtered out — it would be a dead row at the top of the list.
    const ordered = orderTabLaunchAgents(CUSTOM_ID, ['claude'], [customEntry])
    expect(ordered).not.toContain(CUSTOM_ID)
    expect(ordered).toEqual(['claude'])
  })

  it('labels and matches a custom agent by its label and command override, with the base icon id', () => {
    const customs = [{ ...customEntry, commandOverride: 'codex --model gpt-5.6-sol-xhigh' }]
    const options = buildTabAgentLaunchOptions([CUSTOM_ID, 'codex'], {}, customs)
    const custom = options[0]
    expect(custom.label).toBe('Codex-5.6-sol-xhigh')
    expect(custom.baseAgent).toBe('codex')
    // Never the raw custom-agent:... id as the visible label.
    expect(custom.label).not.toContain('custom-agent:')
    const matches = findMatchingTabAgentLaunchOptions('sol-xhigh', options)
    expect(matches.map((o) => o.agent)).toEqual([CUSTOM_ID])
  })

  it('derives only ready, enabled customs whose base is enabled', () => {
    const snapshot = {
      customAgents: [
        {
          status: 'ready',
          definition: { id: CUSTOM_ID, baseAgent: 'codex', label: 'Codex-5.6-sol-xhigh', args: '' },
          envSummary: { entryCount: 0, bytes: 0 },
          availabilityReason: 'baseline-stock'
        },
        {
          status: 'ready',
          definition: {
            id: 'custom-agent:claude:99999999-2222-4333-8444-555555555555',
            baseAgent: 'claude',
            label: 'Disabled-Base-Custom',
            args: ''
          },
          envSummary: { entryCount: 0, bytes: 0 },
          availabilityReason: 'baseline-stock'
        },
        {
          status: 'repair-required',
          label: null,
          repairToken: 't',
          issues: [],
          rawBytes: 10,
          draftAvailability: 'available'
        }
      ]
    } as never
    const entries = deriveTabCustomAgentEntries(snapshot, ['claude'])
    expect(entries.map((entry) => entry.id)).toEqual([CUSTOM_ID])
    expect(deriveTabCustomAgentEntries(snapshot, [CUSTOM_ID, 'claude'])).toEqual([])
    expect(deriveTabCustomAgentEntries(null, [])).toEqual([])
  })
})
