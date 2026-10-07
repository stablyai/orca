// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { createDivider } from './pane-divider'
import { equalizeManagedPaneSizes } from './pane-manager-layout-sweeps'
import type { ManagedPaneInternal } from './pane-manager-types'

function makePane(flex: string): HTMLElement {
  const pane = document.createElement('div')
  pane.className = 'pane'
  pane.style.flex = flex
  return pane
}

describe('pane layout gesture marker', () => {
  it('marks a divider double-click reset as a gesture', () => {
    const onLayoutChanged = vi.fn()
    const split = document.createElement('div')
    const divider = createDivider(true, {}, { refitPanesUnder: vi.fn(), onLayoutChanged })
    split.append(makePane('3 1 0%'), divider, makePane('1 1 0%'))

    divider.dispatchEvent(new MouseEvent('dblclick'))

    expect(onLayoutChanged).toHaveBeenCalledExactlyOnceWith('gesture')
  })

  it('marks an equalize command as a gesture only when it changes sizes', () => {
    const onLayoutChanged = vi.fn()
    const root = document.createElement('div')
    const split = document.createElement('div')
    split.className = 'pane-split'
    split.append(makePane('3 1 0%'), createDivider(true, {}, { refitPanesUnder: vi.fn() }))
    split.append(makePane('1 1 0%'))
    root.append(split)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: equalize reads only the pane count.
    const panes = new Map([
      [1, {}],
      [2, {}]
    ]) as unknown as Map<number, ManagedPaneInternal>

    equalizeManagedPaneSizes(panes, root, onLayoutChanged)
    equalizeManagedPaneSizes(panes, root, onLayoutChanged)

    expect(onLayoutChanged).toHaveBeenCalledExactlyOnceWith('gesture')
  })
})
