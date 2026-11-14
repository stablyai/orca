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
  result: { rows: readonly Row[]; resetOrder: () => void }
  update: (patch: Partial<Props>) => void
} {
  const state = { props: initial }
  const result = { rows: [] as readonly Row[], resetOrder: () => {} }
  function Probe(): null {
    const out = useWorkspaceCleanupHeldRows(state.props)
    result.rows = out.rows
    result.resetOrder = out.resetOrder
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
})
