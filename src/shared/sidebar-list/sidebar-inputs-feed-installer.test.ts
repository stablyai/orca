import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_INPUTS_SCHEMA_VERSION,
  SIDEBAR_INPUTS_SEMANTICS_VERSION,
  type SidebarInputsReadResult
} from './sidebar-inputs-feed-contract'
import {
  INITIAL_SIDEBAR_INPUTS_FEED_STATE,
  refreshSidebarInputs,
  sidebarInputsChanged,
  sidebarInputsReadFailed,
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

/** Installed at g1 revision 3 with rows {a: 1}. */
function installed(): SidebarInputsFeedStep {
  return reply(
    refreshSidebarInputs(INITIAL_SIDEBAR_INPUTS_FEED_STATE),
    page({ kind: 'snapshot', revision: 3, domains: rows({ a: 1 }) })
  )
}

const rowsOf = (step: SidebarInputsFeedStep) =>
  Object.fromEntries(step.state.installed?.domains.get('rows') ?? [])

describe('sidebar inputs installer', () => {
  it('installs a snapshot, then applies a delta from exactly its revision', () => {
    const base = installed()
    expect(base.request).toBeNull()
    const read = sidebarInputsChanged(base.state, { generation: 'g1', revision: 4 })
    expect(read.request?.params).toMatchObject({ generation: 'g1', cursor: 3 })
    const next = reply(
      read,
      page({ kind: 'delta', from: 3, revision: 4, domains: rows({ b: 2 }, ['a']) })
    )
    expect(rowsOf(next)).toEqual({ b: 2 })
    expect(next.state.installed?.revision).toBe(4)
  })

  it('supersedes a read in flight on a stream ready and drops the stale reply', () => {
    const first = refreshSidebarInputs(INITIAL_SIDEBAR_INPUTS_FEED_STATE)
    const second = refreshSidebarInputs(first.state)
    const stale = first.request
    if (!stale) {
      throw new Error('expected a read')
    }
    const dropped = sidebarInputsReplied(
      second.state,
      stale.id,
      page({ kind: 'snapshot', revision: 1 })
    )
    expect(dropped.state).toBe(second.state)
    expect(
      rowsOf(reply(second, page({ kind: 'snapshot', revision: 2, domains: rows({ a: 1 }) })))
    ).toEqual({ a: 1 })
  })

  it('reads once more after a notice its reply does not cover, and not after one it does', () => {
    const base = installed()
    const read = sidebarInputsChanged(base.state, { generation: 'g1', revision: 4 })
    const covered = sidebarInputsChanged(read.state, { generation: 'g1', revision: 5 })
    expect(covered.request).toBeNull()
    expect(
      reply({ ...read, state: covered.state }, page({ kind: 'delta', from: 3, revision: 5 }))
        .request
    ).toBeNull()
    const uncovered = sidebarInputsChanged(read.state, { generation: 'g1', revision: 6 })
    expect(
      reply({ ...read, state: uncovered.state }, page({ kind: 'delta', from: 3, revision: 5 }))
        .request?.params
    ).toMatchObject({
      cursor: 5
    })
  })

  it('forgets a failed read, so the next notice or ready reads again', () => {
    const base = installed()
    const read = sidebarInputsChanged(base.state, { generation: 'g1', revision: 4 })
    const noticed = sidebarInputsChanged(read.state, { generation: 'g1', revision: 5 })
    if (!read.request) {
      throw new Error('expected a read')
    }
    const failed = sidebarInputsReadFailed(noticed.state, read.request.id)
    expect(failed).toMatchObject({ inFlight: null, staged: null, noticed: null })
    expect(
      sidebarInputsChanged(failed, { generation: 'g1', revision: 5 }).request?.params
    ).toMatchObject({
      cursor: 3
    })
    expect(refreshSidebarInputs(failed).request?.params).toMatchObject({ cursor: 3 })
  })

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

  it('reads a snapshot on a delta from elsewhere, a page from another batch, or unjoinable parts', () => {
    const base = installed()
    const read = sidebarInputsChanged(base.state, { generation: 'g1', revision: 5 })
    const mismatch = reply(read, page({ kind: 'delta', from: 2, revision: 5 }))
    expect(mismatch.state.installed).toBe(base.state.installed)
    expect(mismatch.request?.params).toEqual({ maxBytes: expect.any(Number) })

    const paging = reply(read, page({ kind: 'delta', from: 3, revision: 5, next: 'p#1' }))
    expect(reply(paging, page({ kind: 'delta', from: 3, revision: 6 })).request?.params).toEqual({
      maxBytes: expect.any(Number)
    })

    const broken = reply(
      read,
      page({
        kind: 'delta',
        from: 3,
        revision: 5,
        domains: { rows: { upserts: {}, removals: [], parts: { a: '{"unterminated' } } }
      })
    )
    expect(broken.state.installed).toBe(base.state.installed)
    expect(broken.request?.params).toEqual({ maxBytes: expect.any(Number) })
  })

  it('re-reads from what is installed on a reset, and on a notice from a new generation', () => {
    const base = installed()
    const read = refreshSidebarInputs(base.state)
    expect(reply(read, page({ kind: 'reset', revision: 9 })).request?.params).toMatchObject({
      cursor: 3
    })
    const restarted = sidebarInputsChanged(base.state, { generation: 'g2', revision: 1 })
    expect(restarted.request?.params).toMatchObject({ generation: 'g1', cursor: 3 })
    const next = reply(
      restarted,
      page({ generation: 'g2', kind: 'snapshot', revision: 1, domains: rows({ z: 1 }) })
    )
    expect(next.state.installed?.generation).toBe('g2')
    expect(rowsOf(next)).toEqual({ z: 1 })
  })

  it('never installs a snapshot older than what it has', () => {
    const base = installed()
    const late = reply(refreshSidebarInputs(base.state), page({ kind: 'snapshot', revision: 2 }))
    expect(late.state.installed).toBe(base.state.installed)
  })
})
