import { describe, expect, it } from 'vitest'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { getOverrideAffectedPanes, getPanesNeedingOverrideFit } from './override-affected-panes'

function makePane(id: number, cols = 120, rows = 40): ManagedPane {
  return { id, terminal: { cols, rows } } as ManagedPane
}

describe('getOverrideAffectedPanes', () => {
  it('returns only panes bound to the event PTY in this tab', () => {
    const panes = [makePane(1), makePane(2), makePane(3)]
    const bindings = new Map<number, string>([
      [1, 'pty-a'],
      [2, 'pty-b'],
      [3, 'pty-a']
    ])

    const affected = getOverrideAffectedPanes(panes, (paneId) => bindings.get(paneId), 'pty-a')

    expect(affected.map((pane) => pane.id)).toEqual([1, 3])
  })

  it('returns nothing for a watcher whose panes are bound to other PTYs', () => {
    const panes = [makePane(10), makePane(11)]
    const bindings = new Map<number, string>([
      [10, 'pty-x'],
      [11, 'pty-y']
    ])

    const affected = getOverrideAffectedPanes(panes, (paneId) => bindings.get(paneId), 'pty-z')

    expect(affected).toEqual([])
  })

  it('ignores unbound panes (resolver returns undefined)', () => {
    const panes = [makePane(1), makePane(2)]
    const bindings = new Map<number, string>([[1, 'pty-a']])

    const affected = getOverrideAffectedPanes(panes, (paneId) => bindings.get(paneId), 'pty-a')

    expect(affected.map((pane) => pane.id)).toEqual([1])
  })
})

describe('getPanesNeedingOverrideFit', () => {
  it('returns only affected panes whose grid does not already match the override', () => {
    const panes = [makePane(1, 49, 20), makePane(2, 120, 40), makePane(3, 49, 21)]

    const panesNeedingFit = getPanesNeedingOverrideFit(panes, 49, 20)

    expect(panesNeedingFit.map((pane) => pane.id)).toEqual([2, 3])
  })

  it('returns nothing when every affected pane already matches the override', () => {
    const panes = [makePane(1, 49, 20), makePane(2, 49, 20)]

    expect(getPanesNeedingOverrideFit(panes, 49, 20)).toEqual([])
  })
})
