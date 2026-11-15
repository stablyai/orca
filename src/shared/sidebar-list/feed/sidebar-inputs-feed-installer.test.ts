import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsReadResult
} from './sidebar-inputs-feed-contract'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsReplied,
  type SidebarInputsFeedStep
} from './sidebar-inputs-feed-installer'

function page(
  fields: Partial<SidebarInputsReadResult> & Pick<SidebarInputsReadResult, 'kind' | 'revision'>
): SidebarInputsReadResult {
  return {
    generation: 'g1',
    schemaVersion: SIDEBAR_INPUTS_SCHEMA_VERSION,
    semanticsVersion: SIDEBAR_INPUTS_SEMANTICS_VERSION,
    from: null,
    domains: {},
    next: null,
    ...fields
  }
}

const rows = (upserts: Record<string, unknown>, removals: string[] = []) => ({
  rows: { upserts, removals, parts: {} }
})

function reply(
  step: SidebarInputsFeedStep,
  result: SidebarInputsReadResult
): SidebarInputsFeedStep {
  if (!step.request) {
    throw new Error('expected a read')
  }
  return sidebarInputsReplied(step.state, step.request.id, result)
}

const rowsOf = (step: SidebarInputsFeedStep) =>
  Object.fromEntries(step.state.installed?.domains.get('rows') ?? [])

describe('sidebar inputs installer', () => {
  it('stages pages and installs them only once the last lands', () => {
    const first = reply(
      refreshSidebarInputs(INITIAL_SIDEBAR_INPUTS_FEED_STATE),
      page({ kind: 'snapshot', revision: 2, domains: rows({ a: 1 }), next: 'p#1' })
    )
    expect(first.state.installed).toBeNull()
    expect(first.request?.params).toMatchObject({ pageToken: 'p#1' })
    const done = reply(first, page({ kind: 'snapshot', revision: 2, domains: rows({ b: 2 }) }))
    expect(rowsOf(done)).toEqual({ a: 1, b: 2 })
  })

  it('joins an entity’s parts across pages', () => {
    const json = JSON.stringify({ rankedIds: ['x', 'y'] })
    const part = (text: string) => ({ rows: { upserts: {}, removals: [], parts: { order: text } } })
    const first = reply(
      refreshSidebarInputs(INITIAL_SIDEBAR_INPUTS_FEED_STATE),
      page({ kind: 'snapshot', revision: 2, domains: part(json.slice(0, 5)), next: 'p#1' })
    )
    const done = reply(first, page({ kind: 'snapshot', revision: 2, domains: part(json.slice(5)) }))
    expect(rowsOf(done)).toEqual({ order: { rankedIds: ['x', 'y'] } })
  })
})
