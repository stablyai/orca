// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from './pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import { applyExpandedLayoutTo } from '@/components/terminal-pane/expand-collapse'

// Why: happy-dom has no canvas, so xterm cannot open; geometry never touches the terminal.
vi.mock('./pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

const { PaneManager } = await import('./pane-manager')

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const LEAF_C = '33333333-3333-4333-8333-333333333333'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })

describe('PaneManager.applyLayoutGeometry', () => {
  let root: HTMLDivElement
  let onLayoutChanged: Mock<NonNullable<PaneManagerOptions['onLayoutChanged']>>
  let onPaneCreated: Mock<NonNullable<PaneManagerOptions['onPaneCreated']>>
  let onPaneClosed: Mock<NonNullable<PaneManagerOptions['onPaneClosed']>>
  let manager: InstanceType<typeof PaneManager>

  function mountTwoPanes(direction: 'vertical' | 'horizontal', ratio?: number): void {
    const first = manager.createInitialPane({ leafId: LEAF_A })
    manager.splitPane(first.id, direction, { leafId: LEAF_B, ratio })
    clearCallbacks()
  }

  function mountThreePanes(): void {
    const first = manager.createInitialPane({ leafId: LEAF_A })
    const second = manager.splitPane(first.id, 'vertical', { leafId: LEAF_B, ratio: 0.6 })
    expect(second).not.toBeNull()
    manager.splitPane(second!.id, 'horizontal', { leafId: LEAF_C })
    clearCallbacks()
  }

  // Why: mounting itself fires these, so only calls made by the apply count.
  function clearCallbacks(): void {
    onLayoutChanged.mockClear()
    onPaneCreated.mockClear()
    onPaneClosed.mockClear()
  }

  function serialized(): TerminalPaneLayoutNode | null {
    const top = root.firstElementChild
    return top instanceof HTMLElement ? serializePaneTree(top) : null
  }

  function paneIdentity(): unknown[] {
    return manager.getPanes().flatMap((pane) => [pane.id, pane.container, pane.terminal])
  }

  function recordMutations(): () => MutationRecord[] {
    const observer = new MutationObserver(() => {})
    observer.observe(root, { subtree: true, childList: true, attributes: true })
    return () => observer.takeRecords()
  }

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

  it('applies a same-leaf-set ratio change without remounting panes', () => {
    mountTwoPanes('vertical')
    const before = paneIdentity()

    const applied = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'vertical',
      first: leaf(LEAF_A),
      second: leaf(LEAF_B),
      ratio: 0.3
    })

    expect(applied).toBe(true)
    expect(serialized()).toEqual({
      type: 'split',
      direction: 'vertical',
      first: leaf(LEAF_A),
      second: leaf(LEAF_B),
      ratio: 0.3
    })
    expect(paneIdentity()).toEqual(before)
    expect(manager.getPanes().every((pane) => pane.container.isConnected)).toBe(true)
    expect(onPaneCreated).not.toHaveBeenCalled()
    expect(onPaneClosed).not.toHaveBeenCalled()
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('flips orientation in place and swaps the divider to the new axis', () => {
    mountTwoPanes('vertical', 0.4)
    const before = paneIdentity()
    const split = root.firstElementChild
    const oldDivider = root.querySelector('.pane-divider')

    const applied = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_A),
      second: leaf(LEAF_B),
      ratio: 0.4
    })

    expect(applied).toBe(true)
    expect(root.firstElementChild).toBe(split)
    expect(serialized()).toMatchObject({ direction: 'horizontal', ratio: 0.4 })
    const dividers = root.querySelectorAll('.pane-divider')
    expect(dividers).toHaveLength(1)
    expect(dividers[0]).not.toBe(oldDivider)
    expect(dividers[0].classList.contains('is-horizontal')).toBe(true)
    expect(paneIdentity()).toEqual(before)
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('makes no DOM writes for a layout identical to the mounted tree', () => {
    mountThreePanes()
    const layout = serialized()
    expect(layout).not.toBeNull()
    const takeRecords = recordMutations()

    expect(manager.applyLayoutGeometry(layout!)).toBe(false)

    expect(takeRecords()).toEqual([])
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('changes only the nested split whose ratio moved', () => {
    mountThreePanes()
    const before = paneIdentity()

    const next: TerminalPaneLayoutNode = {
      type: 'split',
      direction: 'vertical',
      first: leaf(LEAF_A),
      second: {
        type: 'split',
        direction: 'horizontal',
        first: leaf(LEAF_B),
        second: leaf(LEAF_C),
        ratio: 0.25
      },
      ratio: 0.6
    }
    expect(manager.applyLayoutGeometry(next)).toBe(true)

    expect(serialized()).toEqual(next)
    expect(paneIdentity()).toEqual(before)
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('leaves the DOM untouched when the layout names a different tree', () => {
    mountTwoPanes('vertical')
    const takeRecords = recordMutations()

    const swapped = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_B),
      second: leaf(LEAF_A),
      ratio: 0.3
    })
    const extraLeaf = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_A),
      second: { type: 'split', direction: 'vertical', first: leaf(LEAF_B), second: leaf(LEAF_C) }
    })

    expect(swapped).toBe(false)
    expect(extraLeaf).toBe(false)
    expect(takeRecords()).toEqual([])
  })

  it('leaves a zoomed pane tree untouched', () => {
    mountThreePanes()
    const zoomed = manager.getPanes().find((pane) => pane.leafId === LEAF_C)
    expect(zoomed).toBeDefined()
    const expanded = applyExpandedLayoutTo(zoomed!.id, {
      managerRef: { current: manager },
      containerRef: { current: root },
      expandedStyleSnapshotRef: { current: new Map() }
    })
    expect(expanded).toBe(true)
    const takeRecords = recordMutations()

    const applied = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_A),
      second: { type: 'split', direction: 'vertical', first: leaf(LEAF_B), second: leaf(LEAF_C) },
      ratio: 0.3
    })

    expect(applied).toBe(false)
    expect(takeRecords()).toEqual([])
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('treats a split without a divider as a different tree', () => {
    mountTwoPanes('vertical')
    root.querySelector('.pane-divider')?.remove()
    const takeRecords = recordMutations()

    const applied = manager.applyLayoutGeometry({
      type: 'split',
      direction: 'horizontal',
      first: leaf(LEAF_A),
      second: leaf(LEAF_B)
    })

    expect(applied).toBe(false)
    expect(takeRecords()).toEqual([])
  })
})
