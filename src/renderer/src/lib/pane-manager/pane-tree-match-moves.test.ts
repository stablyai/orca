// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from './pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'

// Why: happy-dom has no canvas, so xterm cannot open; reshaping never touches the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = '44444444-4444-4444-8444-444444444444'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
type Side = string | TerminalPaneLayoutNode
const node = (side: Side): TerminalPaneLayoutNode => (typeof side === 'string' ? leaf(side) : side)
const split = (
  direction: 'vertical' | 'horizontal',
  first: Side,
  second: Side
): TerminalPaneLayoutNode => ({
  type: 'split',
  direction,
  first: node(first),
  second: node(second),
  ratio: 0.5
})

function withoutRatios(node: TerminalPaneLayoutNode | null): unknown {
  if (!node || node.type === 'leaf') {
    return node
  }
  return {
    direction: node.direction,
    first: withoutRatios(node.first),
    second: withoutRatios(node.second)
  }
}

describe('PaneManager.applyLayoutGeometry following the frame tree', () => {
  let root: HTMLDivElement
  let onLayoutChanged: Mock<NonNullable<PaneManagerOptions['onLayoutChanged']>>
  let onPaneCreated: Mock<NonNullable<PaneManagerOptions['onPaneCreated']>>
  let onPaneClosed: Mock<NonNullable<PaneManagerOptions['onPaneClosed']>>
  let manager: InstanceType<typeof PaneManager>

  // A | (B / C), and with D: A | (B / (C | D)).
  function mount(withD = false): void {
    const a = manager.createInitialPane({ leafId: A })
    const b = manager.splitPane(a.id, 'vertical', { leafId: B })
    const c = manager.splitPane(b!.id, 'horizontal', { leafId: C })
    if (withD) {
      manager.splitPane(c!.id, 'vertical', { leafId: D })
    }
    onLayoutChanged.mockClear()
    onPaneCreated.mockClear()
    onPaneClosed.mockClear()
  }

  const serialized = (): TerminalPaneLayoutNode | null => {
    const top = root.firstElementChild
    return top instanceof HTMLElement ? serializePaneTree(top) : null
  }
  const identity = (): unknown[] =>
    manager
      .getPanes()
      .map((pane) => [pane.leafId, pane.container, pane.terminal])
      .sort()

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onLayoutChanged = vi.fn()
    onPaneCreated = vi.fn()
    onPaneClosed = vi.fn()
    manager = new PaneManager(root, {
      linkOpenHint: () => '',
      onLayoutChanged,
      onPaneCreated,
      onPaneClosed
    })
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it.each([
    ['a pane moved to the other side', split('vertical', split('horizontal', B, C), A)],
    ['a regrouped tree', split('horizontal', split('vertical', A, B), C)],
    ['a flat order change', split('vertical', C, split('vertical', A, B))]
  ])('takes %s by moving the mounted panes', (_name, layout) => {
    mount()
    const before = identity()

    expect(manager.applyLayoutGeometry(layout, true)).toBe(true)

    expect(withoutRatios(serialized())).toEqual(withoutRatios(layout))
    expect(identity()).toEqual(before)
    expect(onPaneCreated).not.toHaveBeenCalled()
    expect(onPaneClosed).not.toHaveBeenCalled()
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('takes a deeper tree, splits on both sides', () => {
    mount(true)
    const layout = split('horizontal', split('vertical', D, A), split('vertical', C, B))
    const before = identity()

    expect(manager.applyLayoutGeometry(layout, true)).toBe(true)

    expect(withoutRatios(serialized())).toEqual(withoutRatios(layout))
    expect(identity()).toEqual(before)
  })

  it('moves nothing for the shape already mounted', () => {
    mount()
    const layout = serialized()!
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true })

    expect(manager.applyLayoutGeometry(layout, true)).toBe(false)

    expect(observer.takeRecords()).toEqual([])
  })

  it('changes nothing when the layout names other panes', () => {
    mount()
    const before = serialized()

    expect(manager.applyLayoutGeometry(split('vertical', A, B), true)).toBe(false)
    expect(manager.applyLayoutGeometry(split('vertical', A, split('vertical', B, D)), true)).toBe(
      false
    )

    expect(serialized()).toEqual(before)
  })
})
