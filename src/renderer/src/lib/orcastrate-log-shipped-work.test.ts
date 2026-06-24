import { describe, expect, it } from 'vitest'
import { parseOrchestrateLogOutcomes, selectShippedWork } from './orcastrate-log-shipped-work'

const LOG = [
  JSON.stringify({
    type: 'plan',
    id: 'p-1',
    repo: 'gtm',
    worktrees: [
      { name: 'chore/gtm-e2e-ci', becomes_pr: 'Wire split E2E into ci.yml' },
      { name: 'fix/gtm-brand-copy-audit', becomes_pr: 'brand-review sweep' },
      { name: 'feat/gtm-cf-web-analytics', becomes_pr: 'Add CF Web Analytics beacon' }
    ]
  }),
  '   ', // blank-ish line is skipped
  '{ not valid json', // unparseable line is skipped
  JSON.stringify({
    type: 'outcome',
    plan_id: 'p-1',
    results: [
      { name: 'chore/gtm-e2e-ci', tag: 'shipped' },
      { name: 'fix/gtm-brand-copy-audit', tag: 'shipped' },
      { name: 'feat/gtm-cf-web-analytics', tag: 'over_split' }
    ]
  }),
  // a later outcome with no matching plan → no description
  JSON.stringify({
    type: 'outcome',
    plan_id: 'p-2',
    results: [{ name: 'fix/gtm-content-launch-polish', tag: 'shipped' }]
  })
].join('\n')

describe('parseOrchestrateLogOutcomes', () => {
  it('joins each outcome to its plan description by name', () => {
    const items = parseOrchestrateLogOutcomes(LOG)
    expect(items).toEqual([
      {
        name: 'chore/gtm-e2e-ci',
        tag: 'shipped',
        description: 'Wire split E2E into ci.yml'
      },
      { name: 'fix/gtm-brand-copy-audit', tag: 'shipped', description: 'brand-review sweep' },
      {
        name: 'feat/gtm-cf-web-analytics',
        tag: 'over_split',
        description: 'Add CF Web Analytics beacon'
      },
      { name: 'fix/gtm-content-launch-polish', tag: 'shipped' }
    ])
  })

  it('takes the latest tag when a name appears in multiple outcomes', () => {
    const log = [
      JSON.stringify({ type: 'outcome', results: [{ name: 'a', tag: 'over_split' }] }),
      JSON.stringify({ type: 'outcome', results: [{ name: 'a', tag: 'shipped' }] })
    ].join('\n')
    expect(parseOrchestrateLogOutcomes(log)).toEqual([{ name: 'a', tag: 'shipped' }])
  })

  it('returns nothing for an empty log', () => {
    expect(parseOrchestrateLogOutcomes('')).toEqual([])
  })
})

describe('parseOrchestrateLogOutcomes lifetime scoping', () => {
  // Why: the log is committed, so a new director inherits prior sessions'
  // outcomes. `sinceMs` scopes Shipped to the director's own lifetime.
  const SINCE = Date.parse('2026-06-21T00:00:00Z')
  const SCOPED_LOG = [
    JSON.stringify({
      type: 'plan',
      id: 'p-old',
      worktrees: [{ name: 'feat/old-shipped', becomes_pr: 'Prior session work' }]
    }),
    JSON.stringify({
      type: 'outcome',
      plan_id: 'p-old',
      ts: '2026-06-20T22:41:09Z', // before SINCE → inherited, excluded
      results: [{ name: 'feat/old-shipped', tag: 'shipped' }]
    }),
    JSON.stringify({
      type: 'outcome',
      plan_id: 'p-new',
      ts: '2026-06-21T10:15:00Z', // at/after SINCE → this director's own work
      results: [{ name: 'feat/new-shipped', tag: 'shipped' }]
    })
  ].join('\n')

  it('keeps only outcomes logged at/after sinceMs', () => {
    const items = parseOrchestrateLogOutcomes(SCOPED_LOG, SINCE)
    expect(items.map((item) => item.name)).toEqual(['feat/new-shipped'])
    expect(selectShippedWork(items).map((item) => item.name)).toEqual(['feat/new-shipped'])
  })

  it('returns empty for a brand-new director over an old-only log', () => {
    const NOW = Date.parse('2026-06-24T00:00:00Z')
    expect(parseOrchestrateLogOutcomes(SCOPED_LOG, NOW)).toEqual([])
  })

  it('excludes outcomes with a missing or unparseable ts when scoping', () => {
    const log = [
      JSON.stringify({ type: 'outcome', results: [{ name: 'no-ts', tag: 'shipped' }] }),
      JSON.stringify({
        type: 'outcome',
        ts: 'not-a-date',
        results: [{ name: 'bad-ts', tag: 'shipped' }]
      })
    ].join('\n')
    expect(parseOrchestrateLogOutcomes(log, SINCE)).toEqual([])
  })

  it('is unaffected by ts when sinceMs is omitted (legacy callers)', () => {
    const items = parseOrchestrateLogOutcomes(SCOPED_LOG)
    expect(items.map((item) => item.name)).toEqual(['feat/old-shipped', 'feat/new-shipped'])
  })
})

describe('selectShippedWork', () => {
  it('keeps only shipped outcomes', () => {
    const shipped = selectShippedWork(parseOrchestrateLogOutcomes(LOG))
    expect(shipped.map((item) => item.name)).toEqual([
      'chore/gtm-e2e-ci',
      'fix/gtm-brand-copy-audit',
      'fix/gtm-content-launch-polish'
    ])
  })
})
