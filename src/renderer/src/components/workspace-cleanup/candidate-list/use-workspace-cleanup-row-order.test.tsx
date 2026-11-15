// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import {
  arrangeWorkspaceCleanupHeldRows,
  createWorkspaceCleanupHeldRowOrder,
  useWorkspaceCleanupHeldRows
} from './use-workspace-cleanup-row-order'

type Row = { identity: string; rev: number }
type Props = Parameters<typeof useWorkspaceCleanupHeldRows<Row>>[0]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
})

const row = (identity: string, rev = 0): Row => ({ identity, rev })
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.identity)

function mount(initial: Props): {
  result: {
    rows: readonly Row[]
    resetOrder: () => void
    releaseRows: (identities: readonly string[]) => void
  }
  update: (patch: Partial<Props>) => void
} {
  const state = { props: initial }
  const result = {
    rows: [] as readonly Row[],
    resetOrder: () => {},
    releaseRows: (_identities: readonly string[]) => {}
  }
  function Probe(): null {
    const out = useWorkspaceCleanupHeldRows(state.props)
    result.rows = out.rows
    result.resetOrder = out.resetOrder
    result.releaseRows = out.releaseRows
    return null
  }
  const container = document.createElement('div')
  root = createRoot(container)
  act(() => root!.render(<Probe />))
  return {
    result,
    update: (patch) => {
      state.props = { ...state.props, ...patch }
      act(() => root!.render(<Probe />))
    }
  }
}

function props(rows: Row[], extra: Partial<Props> = {}): Props {
  return {
    liveRows: rows,
    liveRowByIdentity: new Map(rows.map((r) => [r.identity, r])),
    resetKey: 'last-activity:asc:{}',
    open: true,
    loading: false,
    shouldResortAtSettle: () => true,
    ...extra
  }
}

describe('arrangeWorkspaceCleanupHeldRows', () => {
  it('keeps held slots, uses live data, drops vanished rows and appends unseen ones', () => {
    const order = createWorkspaceCleanupHeldRowOrder([row('a'), row('b'), row('c')], 'k')
    const live = [row('d'), row('c', 2), row('a', 2)]
    const byIdentity = new Map([...live, row('b', 2)].map((r) => [r.identity, r]))
    byIdentity.delete('c')
    expect(arrangeWorkspaceCleanupHeldRows(live, byIdentity, order)).toEqual([
      row('a', 2),
      // c vanished from the candidate set; b still exists but no longer matches the live query.
      row('b', 2),
      row('d')
    ])
  })
})

describe('useWorkspaceCleanupHeldRows', () => {
  it('holds order across settle, evidence and size re-sorts while data updates in place', () => {
    const { result, update } = mount(props([row('a'), row('b'), row('c')], { loading: true }))
    update(
      props([row('a'), row('b'), row('c')], { loading: false, shouldResortAtSettle: () => false })
    )
    expect(ids(result.rows)).toEqual(['a', 'b', 'c'])
    // Evidence or size arrives: the live sort now ranks c first and refreshes b's data.
    update(props([row('c', 1), row('b', 1), row('a', 1)], { shouldResortAtSettle: () => false }))
    expect(result.rows).toEqual([row('a', 1), row('b', 1), row('c', 1)])
    update(props([row('b', 2), row('c', 2), row('a', 2)], { shouldResortAtSettle: () => false }))
    expect(ids(result.rows)).toEqual(['a', 'b', 'c'])
  })

  it('keeps a row visible, with live data, after it stops matching until the next reset', () => {
    const all = [row('a'), row('b'), row('c')]
    const { result, update } = mount(props(all))
    const unsafeB = row('b', 5)
    update({
      liveRows: [row('a'), row('c')],
      liveRowByIdentity: new Map([row('a'), unsafeB, row('c')].map((r) => [r.identity, r]))
    })
    expect(result.rows).toEqual([row('a'), unsafeB, row('c')])
  })

  it('appends late rows at the end, then keeps their slot', () => {
    const { result, update } = mount(props([row('b'), row('c')]))
    update(props([row('a'), row('b'), row('c')]))
    expect(ids(result.rows)).toEqual(['b', 'c', 'a'])
    update(props([row('a', 1), row('b'), row('c')]))
    expect(ids(result.rows)).toEqual(['b', 'c', 'a'])
  })

  it('drops rows that no longer exist', () => {
    const { result, update } = mount(props([row('a'), row('b'), row('c')]))
    update(props([row('a'), row('c')]))
    expect(ids(result.rows)).toEqual(['a', 'c'])
  })

  it('resets on sort or filter change', () => {
    const { result, update } = mount(props([row('a'), row('b'), row('c')]))
    update(props([row('c'), row('a'), row('b')], { resetKey: 'size:desc:{}' }))
    expect(ids(result.rows)).toEqual(['c', 'a', 'b'])
    update(props([row('b'), row('c')], { resetKey: 'size:desc:{"query":"x"}' }))
    expect(ids(result.rows)).toEqual(['b', 'c'])
  })

  it('resets when a scan starts (Refresh) and when the dialog reopens', () => {
    const { result, update } = mount(props([row('a'), row('b')]))
    update(props([row('b'), row('a')]))
    expect(ids(result.rows)).toEqual(['a', 'b'])
    update(props([row('b'), row('a')], { loading: true }))
    expect(ids(result.rows)).toEqual(['b', 'a'])
    update(props([row('b'), row('a')], { open: false }))
    update(props([row('a'), row('b')], { open: true }))
    expect(ids(result.rows)).toEqual(['a', 'b'])
  })

  it('keeps a kept (selected) row in its slot through a scan-start reset after it stops matching', () => {
    const keep = new Set(['b'])
    const { result, update } = mount(props([row('a'), row('b'), row('c')], { keepIdentities: keep }))
    const all = new Map([row('a'), row('b', 1), row('c')].map((r) => [r.identity, r]))
    // b stops matching; Refresh starts and the live order changes.
    update({ liveRows: [row('c'), row('a')], liveRowByIdentity: all, loading: true })
    // b goes right before c, the row that followed it, with its live data.
    expect(result.rows).toEqual([row('b', 1), row('c'), row('a')])
    // The new order then holds like any other.
    update({ liveRows: [row('a'), row('c')], loading: true })
    expect(ids(result.rows)).toEqual(['b', 'c', 'a'])
  })

  it('places a kept row before the row that followed it, and drops it once it no longer exists', () => {
    const keep = new Set(['b'])
    const { result, update } = mount(props([row('a'), row('b'), row('c')], { keepIdentities: keep }))
    update({
      liveRows: [row('a'), row('c')],
      liveRowByIdentity: new Map([row('a'), row('b'), row('c')].map((r) => [r.identity, r])),
      loading: true
    })
    expect(ids(result.rows)).toEqual(['a', 'b', 'c'])
    update({ liveRowByIdentity: new Map([row('a'), row('c')].map((r) => [r.identity, r])) })
    expect(ids(result.rows)).toEqual(['a', 'c'])
  })

  it('does not keep a non-matching row across the user changing sort or filters', () => {
    const keep = new Set(['b'])
    const { result, update } = mount(props([row('a'), row('b'), row('c')], { keepIdentities: keep }))
    update({
      liveRows: [row('a'), row('c')],
      liveRowByIdentity: new Map([row('a'), row('b'), row('c')].map((r) => [r.identity, r])),
      resetKey: 'last-activity:asc:{"query":"x"}'
    })
    expect(ids(result.rows)).toEqual(['a', 'c'])
  })

  it('re-sorts once at scan settle only while the user has not started working', () => {
    const { result, update } = mount(props([row('a'), row('b')], { loading: true }))
    update(props([row('b'), row('a')], { loading: false, shouldResortAtSettle: () => true }))
    expect(ids(result.rows)).toEqual(['b', 'a'])

    const held = mount(props([row('a'), row('b')], { loading: true }))
    held.update(props([row('b'), row('a')], { loading: false, shouldResortAtSettle: () => false }))
    expect(ids(held.result.rows)).toEqual(['a', 'b'])
  })

  it('resetOrder re-derives the order on demand', () => {
    const { result, update } = mount(props([row('a'), row('b')]))
    update(props([row('b'), row('a')]))
    expect(ids(result.rows)).toEqual(['a', 'b'])
    act(() => result.resetOrder())
    expect(ids(result.rows)).toEqual(['b', 'a'])
  })

  it('releaseRows drops only that row, and it re-enters at the end without moving others', () => {
    const all = [row('a'), row('b'), row('c')]
    const { result, update } = mount(props(all))
    // b is ignored: it leaves the live result and its slot is released.
    update(props([row('a'), row('c')]))
    act(() => result.releaseRows(['b']))
    expect(ids(result.rows)).toEqual(['a', 'c'])
    // Restored: it matches again and appends after the others instead of re-sorting them.
    update(props([row('a'), row('b'), row('c')]))
    expect(ids(result.rows)).toEqual(['a', 'c', 'b'])
  })

  it('re-sorts when git checking finishes under the settle rule', () => {
    const { result, update } = mount(props([row('a'), row('b')], { gitChecking: true }))
    update(props([row('b'), row('a')], { gitChecking: true }))
    expect(ids(result.rows)).toEqual(['a', 'b'])
    update(props([row('b'), row('a')], { gitChecking: false, shouldResortAtSettle: () => true }))
    expect(ids(result.rows)).toEqual(['b', 'a'])
  })

  it('keeps order when git checking finishes after the user has started working', () => {
    const { result, update } = mount(props([row('a'), row('b')], { gitChecking: true }))
    update(props([row('b'), row('a')], { gitChecking: false, shouldResortAtSettle: () => false }))
    expect(ids(result.rows)).toEqual(['a', 'b'])
  })
})
