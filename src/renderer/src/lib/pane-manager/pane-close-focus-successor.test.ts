// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPane } from './pane-manager-types'

// Why: happy-dom has no canvas, so xterm cannot open; focus routing never needs a rendered terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

type Manager = InstanceType<typeof PaneManager>

function split(
  manager: Manager,
  source: ManagedPane,
  direction: 'vertical' | 'horizontal'
): ManagedPane {
  const pane = manager.splitPane(source.id, direction)
  if (!pane) {
    throw new Error(`split of pane ${source.id} failed`)
  }
  return pane
}

/** a | b | c | d, each split taken from the newest pane. */
function createFourColumns(manager: Manager): [ManagedPane, ManagedPane, ManagedPane, ManagedPane] {
  const a = manager.createInitialPane()
  const b = split(manager, a, 'vertical')
  const c = split(manager, b, 'vertical')
  const d = split(manager, c, 'vertical')
  return [a, b, c, d]
}

describe('PaneManager focus after a pane leaves a split', () => {
  let root: HTMLDivElement
  let manager: Manager

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    manager = new PaneManager(root, { linkOpenHint: () => '' })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it('focuses the adjacent pane of the subtree that takes over a closed middle pane', () => {
    const [, b, c] = createFourColumns(manager)
    manager.setActivePane(b.id)

    manager.closePane(b.id)

    expect(manager.getActivePane()?.id).toBe(c.id)
  })

  it('walks into the edge of an orthogonal split that takes over the space', () => {
    // [ a | b ] over [ c ], all left of d: closing d must land on b, which touches d's edge.
    const a = manager.createInitialPane()
    const d = split(manager, a, 'vertical')
    split(manager, a, 'horizontal')
    const b = split(manager, a, 'vertical')
    manager.setActivePane(d.id)

    manager.closePane(d.id)

    expect(manager.getActivePane()?.id).toBe(b.id)
  })

  it('keeps the active pane when a different pane closes', () => {
    const [, b, , d] = createFourColumns(manager)

    manager.closePane(b.id)

    expect(manager.getActivePane()?.id).toBe(d.id)
  })

  it('focuses the neighbour when the active pane is detached into another tab', () => {
    const [, , c, d] = createFourColumns(manager)

    expect(manager.detachPaneForExternalMove(d.id)).toBe(true)

    expect(manager.getActivePane()?.id).toBe(c.id)
  })

  it('focuses the neighbour when the active pane is retired with its PTY kept', () => {
    const [, , c, d] = createFourColumns(manager)
    manager.setActivePane(c.id)

    expect(manager.retirePanePreservingPty(c.id)).toBe(true)

    expect(manager.getActivePane()?.id).toBe(d.id)
  })
})
