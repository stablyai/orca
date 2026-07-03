import { describe, it, expect } from 'vitest'
import { reconcileTabOrder } from './reconcile-order'

describe('reconcileTabOrder', () => {
  it('returns all IDs when no stored order exists', () => {
    expect(reconcileTabOrder(undefined, ['t1', 't2'], ['e1'])).toEqual(['t1', 't2', 'e1'])
  })

  it('preserves stored order for existing items', () => {
    expect(reconcileTabOrder(['e1', 't1'], ['t1'], ['e1'])).toEqual(['e1', 't1'])
  })

  it('appends new items at the end', () => {
    expect(reconcileTabOrder(['t1'], ['t1', 't2'], ['e1'])).toEqual(['t1', 't2', 'e1'])
  })

  it('drops stored IDs that no longer exist', () => {
    expect(reconcileTabOrder(['gone', 't1'], ['t1'], [])).toEqual(['t1'])
  })

  it('deduplicates IDs that appear in both terminal and editor lists', () => {
    // Edge case: same ID in both lists should only appear once
    expect(reconcileTabOrder(undefined, ['x'], ['x'])).toEqual(['x'])
  })

  it('handles empty inputs', () => {
    expect(reconcileTabOrder(undefined, [], [])).toEqual([])
    expect(reconcileTabOrder([], [], [])).toEqual([])
  })

  it('maintains interleaved stored order across types', () => {
    const stored = ['t1', 'e1', 't2', 'e2']
    expect(reconcileTabOrder(stored, ['t1', 't2'], ['e1', 'e2'])).toEqual(['t1', 'e1', 't2', 'e2'])
  })

  it('includes git-graph ids in the validity set and appends new ones', () => {
    // git-graph is the 6th tab kind; a stored order referencing it must keep it,
    // and a brand-new git-graph tab must be appended like any other kind.
    expect(reconcileTabOrder(['gg1', 't1'], ['t1'], [], [], [], ['gg1'])).toEqual(['gg1', 't1'])
    expect(reconcileTabOrder(['t1'], ['t1'], [], [], [], ['gg1'])).toEqual(['t1', 'gg1'])
  })

  it('drops a stored git-graph id once the tab no longer exists', () => {
    expect(reconcileTabOrder(['gg-gone', 't1'], ['t1'], [], [], [], [])).toEqual(['t1'])
  })
})
