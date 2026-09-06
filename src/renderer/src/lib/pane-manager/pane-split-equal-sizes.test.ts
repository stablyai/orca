// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

vi.mock('./pane-tree-ops', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  captureScrollState: vi.fn(() => null),
  safeFit: vi.fn()
}))

vi.mock('./pane-lifecycle', () => ({
  disposePane: vi.fn(),
  openTerminal: vi.fn()
}))

vi.mock('./pane-webgl-renderer', () => ({ disposeWebgl: vi.fn() }))
vi.mock('./pane-webgl-reattach', () => ({ reattachWebglIfNeeded: vi.fn() }))
vi.mock('./pane-split-scroll', () => ({
  clearPendingSplitScrollRestore: vi.fn(),
  scheduleSplitScrollRestore: vi.fn()
}))
vi.mock('./pane-drag-reorder', () => ({ updateMultiPaneState: vi.fn() }))
vi.mock('./pane-divider', () => ({
  applyDividerStyles: vi.fn(),
  applyPaneOpacity: vi.fn()
}))

import { splitManagedPane } from './pane-split-close'

let nextPaneId = 0

function createPane(): ManagedPaneInternal {
  nextPaneId += 1
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(nextPaneId)
  return {
    id: nextPaneId,
    leafId: `leaf-${nextPaneId}` as TerminalLeafId,
    terminal: { focus: vi.fn() },
    container,
    webglAddon: null,
    pendingSplitScrollState: null
  } as unknown as ManagedPaneInternal
}

/** Rendered share of each pane, left to right, as flex-grow weights. */
function paneFlexGrowths(root: HTMLElement): number[] {
  return Array.from(root.querySelectorAll<HTMLElement>('.pane')).map((pane) => {
    let share = Number.parseFloat(pane.style.flex) || 1
    let node = pane.parentElement
    while (node && node !== root) {
      if (node.classList.contains('pane-split')) {
        const siblings = Array.from(node.children).filter(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            (child.classList.contains('pane') || child.classList.contains('pane-split'))
        )
        const total = siblings.reduce(
          (sum, sibling) => sum + (Number.parseFloat(sibling.style.flex) || 1),
          0
        )
        share *= (Number.parseFloat(node.style.flex) || 1) / (total || 1)
      }
      node = node.parentElement
    }
    return Math.round(share * 1000) / 1000
  })
}

describe('splitManagedPane pane sizing', () => {
  let root: HTMLElement
  let panes: Map<number, ManagedPaneInternal>

  const split = (paneId: number, opts?: Parameters<typeof splitManagedPane>[0]['opts']) =>
    splitManagedPane({
      paneId,
      direction: 'vertical',
      opts,
      panes,
      root,
      styleOptions: {},
      managerOptions: { linkOpenHint: () => '' },
      createPaneInternal: () => {
        const pane = createPane()
        panes.set(pane.id, pane)
        return pane
      },
      createDivider: () => {
        const divider = document.createElement('div')
        divider.className = 'pane-divider'
        return divider
      },
      publishPaneCreated: vi.fn(),
      getDragCallbacks: () => ({}) as never,
      setActivePaneId: vi.fn(),
      isDestroyed: () => false
    })

  beforeEach(() => {
    nextPaneId = 0
    root = document.createElement('div')
    document.body.replaceChildren(root)
    const initial = createPane()
    root.appendChild(initial.container)
    panes = new Map([[initial.id, initial]])
  })

  it('splits an untouched layout into equal shares as panes are added', () => {
    split(1)
    expect(paneFlexGrowths(root)).toEqual([0.5, 0.5])

    split(2)
    expect(paneFlexGrowths(root)).toEqual([0.333, 0.333, 0.333])

    split(3)
    expect(paneFlexGrowths(root)).toEqual([0.25, 0.25, 0.25, 0.25])
  })

  it('keeps a dragged divider ratio instead of re-equalizing', () => {
    split(1)
    const [first, second] = Array.from(root.querySelectorAll<HTMLElement>('.pane'))
    first.style.flex = '0.8 1 0%'
    second.style.flex = '0.2 1 0%'

    split(2)

    expect(paneFlexGrowths(root)).toEqual([0.8, 0.1, 0.1])
  })

  it('keeps caller-supplied ratios so layout replay restores exact sizes', () => {
    split(1, { ratio: 0.75 })
    expect(paneFlexGrowths(root)).toEqual([0.75, 0.25])
  })

  it('equalizes past a ratio that would collapse a pane, since it is not applied', () => {
    split(1)
    // Why: wrapInSplit discards a ratio outside (0, 1), leaving an even split —
    // so the layout is still ours to re-weight.
    split(2, { ratio: 0 })

    expect(paneFlexGrowths(root)).toEqual([0.333, 0.333, 0.333])
  })

  it('keeps sizes when the caller preserves them', () => {
    split(1)
    split(2, { preserveSiblingSizes: true })

    expect(paneFlexGrowths(root)).toEqual([0.5, 0.25, 0.25])
  })
})
