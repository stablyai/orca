import { describe, expect, it } from 'vitest'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import type {
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'
import {
  customAgentCatalogEntryById,
  mergeCustomAgentCatalogEntries
} from './custom-agent-catalog-entries'

const CODEX = 'custom-agent:codex:aaaa' as CustomTuiAgentId
const CLAUDE_CUSTOM = 'custom-agent:claude:bbbb' as CustomTuiAgentId

function builtIn(id: TuiAgent, label: string, cmd: string): AgentCatalogEntry {
  return { id, label, cmd, homepageUrl: 'https://example.com' }
}

const BUILT_INS: AgentCatalogEntry[] = [
  builtIn('codex', 'Codex', 'codex'),
  builtIn('claude', 'Claude', 'claude')
]

function readyCustom(
  id: CustomTuiAgentId,
  baseAgent: 'codex' | 'claude',
  label: string,
  availabilityReason: 'baseline-stock' | 'configured-executable' | 'custom-path',
  commandOverride?: string
): LocalCustomTuiAgent {
  return {
    status: 'ready',
    definition: {
      id,
      baseAgent,
      label,
      args: '',
      syncEnv: false,
      ...(commandOverride ? { commandOverride } : {})
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason
  }
}

function snapshot(customAgents: LocalCustomTuiAgent[]): LocalAgentCatalogSnapshot {
  return { customAgents } as unknown as LocalAgentCatalogSnapshot
}

describe('mergeCustomAgentCatalogEntries', () => {
  it('groups a ready baseline-stock custom under its detected base with the base icon + human label', () => {
    const merged = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([readyCustom(CODEX, 'codex', 'My Codex', 'baseline-stock')]),
      [],
      new Set<TuiAgent>(['codex', 'claude'])
    )
    expect(merged.map((entry) => entry.id)).toEqual(['codex', CODEX, 'claude'])
    const custom = merged.find((entry) => entry.id === CODEX)
    expect(custom).toMatchObject({ label: 'My Codex', baseAgent: 'codex', cmd: 'codex' })
  })

  it('gates a baseline-stock custom on its base being detected', () => {
    const withoutBase = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([readyCustom(CODEX, 'codex', 'My Codex', 'baseline-stock')]),
      [],
      new Set<TuiAgent>(['claude'])
    )
    expect(withoutBase.some((entry) => entry.id === CODEX)).toBe(false)
  })

  it('does not detection-gate when detection is unknown (null)', () => {
    const merged = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([readyCustom(CODEX, 'codex', 'My Codex', 'baseline-stock')]),
      [],
      null
    )
    expect(merged.some((entry) => entry.id === CODEX)).toBe(true)
  })

  it('offers a configured-executable custom even when its base is undetected, using the override command', () => {
    const merged = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([
        readyCustom(CODEX, 'codex', 'Scripted Codex', 'configured-executable', '/opt/bin/agent')
      ]),
      [],
      new Set<TuiAgent>(['claude'])
    )
    const custom = merged.find((entry) => entry.id === CODEX)
    expect(custom).toMatchObject({ cmd: '/opt/bin/agent', baseAgent: 'codex' })
  })

  it('appends a launch-reported custom whose base row is absent from the built-in list', () => {
    const merged = mergeCustomAgentCatalogEntries(
      [builtIn('claude', 'Claude', 'claude')],
      snapshot([
        readyCustom(CODEX, 'codex', 'Scripted Codex', 'configured-executable', '/opt/bin/agent')
      ]),
      [],
      null
    )
    expect(merged.map((entry) => entry.id)).toEqual(['claude', CODEX])
  })

  it('drops a disabled custom and a base-disabled custom', () => {
    const disabledCustom = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([
        readyCustom(CODEX, 'codex', 'My Codex', 'configured-executable', '/opt/bin/agent')
      ]),
      [CODEX],
      null
    )
    expect(disabledCustom.some((entry) => entry.id === CODEX)).toBe(false)

    const baseDisabled = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([
        readyCustom(CODEX, 'codex', 'My Codex', 'configured-executable', '/opt/bin/agent')
      ]),
      ['codex'],
      null
    )
    expect(baseDisabled.some((entry) => entry.id === CODEX)).toBe(false)
  })

  it('skips repair-required rows and never surfaces a raw custom id as a label', () => {
    const merged = mergeCustomAgentCatalogEntries(
      BUILT_INS,
      snapshot([
        readyCustom(CODEX, 'codex', 'My Codex', 'configured-executable', '/opt/bin/agent'),
        readyCustom(
          CLAUDE_CUSTOM,
          'claude',
          'My Claude',
          'configured-executable',
          '/opt/bin/claude'
        ),
        {
          status: 'repair-required',
          id: 'custom-agent:codex:broken' as CustomTuiAgentId,
          label: null,
          repairToken: 'tok',
          issues: [],
          rawBytes: 0,
          draftAvailability: 'available'
        }
      ]),
      [],
      null
    )
    expect(merged.some((entry) => entry.id === 'custom-agent:codex:broken')).toBe(false)
    for (const entry of merged) {
      expect(entry.label.startsWith('custom-agent:')).toBe(false)
    }
  })

  it('returns a copy of the built-ins when there are no ready customs', () => {
    const merged = mergeCustomAgentCatalogEntries(BUILT_INS, snapshot([]), [], null)
    expect(merged.map((entry) => entry.id)).toEqual(['codex', 'claude'])
    expect(merged).not.toBe(BUILT_INS)
  })

  it('returns a copy of the built-ins when the snapshot is null', () => {
    const merged = mergeCustomAgentCatalogEntries(BUILT_INS, null, [], null)
    expect(merged.map((entry) => entry.id)).toEqual(['codex', 'claude'])
  })
})

describe('customAgentCatalogEntryById', () => {
  it('adapts a ready custom by id regardless of enabled/detection state (draft-keep)', () => {
    const entry = customAgentCatalogEntryById(
      snapshot([readyCustom(CODEX, 'codex', 'My Codex', 'baseline-stock')]),
      CODEX
    )
    expect(entry).toMatchObject({ id: CODEX, label: 'My Codex', baseAgent: 'codex', cmd: 'codex' })
  })

  it('returns null for an unknown id, a null snapshot, and a repair-required row', () => {
    expect(customAgentCatalogEntryById(snapshot([]), CODEX)).toBeNull()
    expect(customAgentCatalogEntryById(null, CODEX)).toBeNull()
    const brokenId = 'custom-agent:codex:broken' as CustomTuiAgentId
    expect(
      customAgentCatalogEntryById(
        snapshot([
          {
            status: 'repair-required',
            id: brokenId,
            label: null,
            repairToken: 'tok',
            issues: [],
            rawBytes: 0,
            draftAvailability: 'available'
          }
        ]),
        brokenId
      )
    ).toBeNull()
  })
})
