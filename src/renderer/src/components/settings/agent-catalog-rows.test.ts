import { describe, expect, it } from 'vitest'
import {
  agentCatalogRowKey,
  deriveAgentCatalogRows,
  filterAgentCatalogRows,
  type AgentCatalogRow,
  type AgentCatalogRowsInput
} from './agent-catalog-rows'
import type {
  AgentCatalogRepairIssue,
  LocalAgentCatalogSnapshot,
  LocalCustomTuiAgent
} from '../../../../shared/agent-catalog-snapshot'
import type { CustomTuiAgentId, TuiAgent } from '../../../../shared/types'

function readyCustom(
  overrides: Partial<{
    id: CustomTuiAgentId
    base: 'codex' | 'claude'
    label: string
    commandOverride?: string
    args: string
    availabilityReason: 'baseline-stock' | 'configured-executable' | 'custom-path'
  }>
): LocalCustomTuiAgent {
  const base = overrides.base ?? 'codex'
  return {
    status: 'ready',
    definition: {
      id: overrides.id ?? (`custom-agent:${base}:one` as CustomTuiAgentId),
      baseAgent: base,
      label: overrides.label ?? 'My Codex',
      commandOverride: overrides.commandOverride,
      args: overrides.args ?? '',
      syncEnv: false
    },
    envSummary: { entryCount: 0, bytes: 0 },
    availabilityReason: overrides.availabilityReason ?? 'baseline-stock'
  }
}

function snapshot(overrides: Partial<LocalAgentCatalogSnapshot>): LocalAgentCatalogSnapshot {
  return {
    version: 1,
    revision: 1,
    defaultAgent: 'auto',
    disabledAgents: [],
    customAgents: [],
    deletedCustomAgents: [],
    repairIssues: [],
    projection: { status: 'ready', bytes: 0, maxBytes: 524_288 },
    localStorage: { status: 'ready', bytes: 0, maxBytes: 16_777_216 },
    ...overrides
  }
}

function input(overrides: Partial<AgentCatalogRowsInput>): AgentCatalogRowsInput {
  return {
    snapshot: overrides.snapshot ?? snapshot({}),
    settings: overrides.settings ?? { agentCmdOverrides: {} },
    detectedIds: overrides.detectedIds ?? null,
    deletedReferenceCounts: overrides.deletedReferenceCounts
  }
}

function findRow(
  rows: AgentCatalogRow[],
  predicate: (row: AgentCatalogRow) => boolean
): AgentCatalogRow {
  const row = rows.find(predicate)
  if (!row) {
    throw new Error('row not found')
  }
  return row
}

describe('deriveAgentCatalogRows ordering', () => {
  it('renders every built-in in canonical product order', () => {
    const rows = deriveAgentCatalogRows(input({}))
    const builtInIds = rows
      .filter((r) => r.kind === 'built-in')
      .map((r) => (r as { id: string }).id)
    expect(builtInIds.indexOf('claude')).toBe(0)
    expect(builtInIds.indexOf('codex')).toBeGreaterThan(builtInIds.indexOf('claude'))
    expect(builtInIds).toContain('gemini')
  })

  it('places a ready custom immediately below its base', () => {
    const rows = deriveAgentCatalogRows(
      input({ snapshot: snapshot({ customAgents: [readyCustom({ base: 'codex' })] }) })
    )
    const codexIndex = rows.findIndex((r) => r.kind === 'built-in' && r.id === 'codex')
    expect(rows[codexIndex + 1]).toMatchObject({ kind: 'custom', baseAgent: 'codex' })
  })

  it('groups a repair row under its base and orphans a baseless one at the end', () => {
    const orphan: LocalCustomTuiAgent = {
      status: 'repair-required',
      label: null,
      repairToken: 'tok-orphan',
      issues: [],
      rawBytes: 10,
      draftAvailability: 'available'
    }
    const grouped: LocalCustomTuiAgent = {
      status: 'repair-required',
      baseAgent: 'claude',
      label: 'Broken Claude',
      repairToken: 'tok-claude',
      issues: [],
      rawBytes: 10,
      draftAvailability: 'available'
    }
    const rows = deriveAgentCatalogRows(
      input({ snapshot: snapshot({ customAgents: [orphan, grouped] }) })
    )
    const claudeIndex = rows.findIndex((r) => r.kind === 'built-in' && r.id === 'claude')
    expect(rows[claudeIndex + 1]).toMatchObject({ kind: 'repair', repairToken: 'tok-claude' })
    expect(rows.at(-1)).toMatchObject({ kind: 'repair', repairToken: 'tok-orphan' })
  })

  it('renders a deleted tombstone with its live reference count', () => {
    const id = 'custom-agent:codex:gone' as CustomTuiAgentId
    const rows = deriveAgentCatalogRows(
      input({
        snapshot: snapshot({
          deletedCustomAgents: [{ id, baseAgent: 'codex', label: 'Retired', deletedAt: 1 }]
        }),
        deletedReferenceCounts: new Map([[id, 3]])
      })
    )
    expect(findRow(rows, (r) => r.kind === 'deleted')).toMatchObject({
      kind: 'deleted',
      label: 'Retired',
      referenceCount: 3
    })
  })
})

describe('deriveAgentCatalogRows status', () => {
  it('maps availabilityReason to Custom executable / Custom PATH', () => {
    const rows = deriveAgentCatalogRows(
      input({
        snapshot: snapshot({
          customAgents: [
            readyCustom({
              id: 'custom-agent:codex:a',
              availabilityReason: 'configured-executable'
            }),
            readyCustom({ id: 'custom-agent:codex:b', availabilityReason: 'custom-path' })
          ]
        })
      })
    )
    expect(
      findRow(rows, (r) => r.kind === 'custom' && r.id === 'custom-agent:codex:a')
    ).toMatchObject({ status: 'custom-executable' })
    expect(
      findRow(rows, (r) => r.kind === 'custom' && r.id === 'custom-agent:codex:b')
    ).toMatchObject({ status: 'custom-path' })
  })

  it('reports base-disabled for a custom whose base harness is disabled', () => {
    const rows = deriveAgentCatalogRows(
      input({
        snapshot: snapshot({
          disabledAgents: ['codex'] as TuiAgent[],
          customAgents: [readyCustom({ base: 'codex' })]
        })
      })
    )
    expect(findRow(rows, (r) => r.kind === 'custom')).toMatchObject({ status: 'base-disabled' })
  })

  it('reports disabled for the custom itself before base', () => {
    const id = 'custom-agent:codex:one' as CustomTuiAgentId
    const rows = deriveAgentCatalogRows(
      input({
        snapshot: snapshot({
          disabledAgents: [id] as TuiAgent[],
          customAgents: [readyCustom({ id })]
        })
      })
    )
    expect(findRow(rows, (r) => r.kind === 'custom')).toMatchObject({
      status: 'disabled',
      enabled: false
    })
  })

  it('labels a built-in with a command override Custom executable', () => {
    const rows = deriveAgentCatalogRows(
      input({ settings: { agentCmdOverrides: { codex: '/opt/codex' } }, detectedIds: new Set() })
    )
    expect(findRow(rows, (r) => r.kind === 'built-in' && r.id === 'codex')).toMatchObject({
      status: 'custom-executable',
      commandSummary: '/opt/codex'
    })
  })

  it('reports not-installed only under a concrete detection set', () => {
    const detected = deriveAgentCatalogRows(input({ detectedIds: new Set(['claude']) }))
    expect(findRow(detected, (r) => r.kind === 'built-in' && r.id === 'codex')).toMatchObject({
      status: 'not-installed'
    })
    // Detection in flight (null) makes no availability claim.
    const inflight = deriveAgentCatalogRows(input({ detectedIds: null }))
    expect(findRow(inflight, (r) => r.kind === 'built-in' && r.id === 'codex')).toMatchObject({
      status: 'enabled'
    })
  })
})

describe('filterAgentCatalogRows', () => {
  const rows = deriveAgentCatalogRows(
    input({ snapshot: snapshot({ customAgents: [readyCustom({ label: 'Nightly Codex' })] }) })
  )

  it('returns the full list unchanged for an empty query', () => {
    expect(filterAgentCatalogRows(rows, '   ')).toHaveLength(rows.length)
  })

  it('matches by custom label', () => {
    const hits = filterAgentCatalogRows(rows, 'nightly')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ kind: 'custom', label: 'Nightly Codex' })
  })

  it('matches by base harness canonical name', () => {
    expect(filterAgentCatalogRows(rows, 'gemini').some((r) => r.kind === 'built-in')).toBe(true)
  })

  it('returns nothing for a no-match query', () => {
    expect(filterAgentCatalogRows(rows, 'zzz-no-such-agent')).toHaveLength(0)
  })
})

function repairCustom(
  overrides: Partial<{
    id: CustomTuiAgentId
    baseAgent: 'codex' | 'claude'
    label: string | null
    repairToken: string
    issues: AgentCatalogRepairIssue[]
    draftAvailability: 'available' | 'too-large'
  }>
): LocalCustomTuiAgent {
  return {
    status: 'repair-required',
    id: overrides.id,
    baseAgent: overrides.baseAgent,
    label: overrides.label ?? null,
    repairToken: overrides.repairToken ?? 'tok',
    issues: overrides.issues ?? [],
    rawBytes: 10,
    draftAvailability: overrides.draftAvailability ?? 'available'
  }
}

describe('deriveAgentCatalogRows repair routing', () => {
  function routeOf(agent: LocalCustomTuiAgent): string {
    const rows = deriveAgentCatalogRows(input({ snapshot: snapshot({ customAgents: [agent] }) }))
    const repair = rows.find((row) => row.kind === 'repair')
    if (!repair || repair.kind !== 'repair') {
      throw new Error('no repair row derived')
    }
    return repair.route
  }

  it('routes a duplicate-id row to the grouped resolver', () => {
    expect(
      routeOf(
        repairCustom({
          id: 'custom-agent:codex:dup' as CustomTuiAgentId,
          baseAgent: 'codex',
          issues: [{ field: 'identity', reason: 'duplicate_id' }]
        })
      )
    ).toBe('duplicate')
  })

  it('routes a canonical id+base row to the editor', () => {
    expect(
      routeOf(
        repairCustom({
          id: 'custom-agent:codex:ok' as CustomTuiAgentId,
          baseAgent: 'codex',
          issues: [{ field: 'args', reason: 'unterminated_quote' }]
        })
      )
    ).toBe('edit')
  })

  it('routes a non-addressable row to discard/replace', () => {
    expect(
      routeOf(
        repairCustom({ baseAgent: 'codex', issues: [{ field: 'identity', reason: 'empty' }] })
      )
    ).toBe('discard-replace')
  })
})

describe('agentCatalogRowKey', () => {
  it('keys configured rows by id and malformed rows by repair token', () => {
    const rows = deriveAgentCatalogRows(input({}))
    expect(
      agentCatalogRowKey(findRow(rows, (r) => r.kind === 'built-in' && r.id === 'claude'))
    ).toBe('claude')
    expect(
      agentCatalogRowKey({
        kind: 'repair',
        repairToken: 'tok',
        baseAgent: 'claude',
        label: null,
        issues: [],
        draftAvailability: 'available',
        route: 'discard-replace',
        searchSummary: ''
      })
    ).toBe('repair:tok')
  })
})
