// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  expectPaneToAppear,
  expectPaneToClose,
  takePaneAppearIntent
} from '@/runtime/layout-owner-pane-intents'
import { serializePaneTree } from './layout-serialization'

// Why: happy-dom has no canvas, so xterm cannot open; the reconciler never touches the terminal.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})
const recordCreatedTerminalPaneSplit = vi.hoisted(() => vi.fn())
vi.mock('./terminal-pane-split-completion', () => ({ recordCreatedTerminalPaneSplit }))

const { PaneManager } = await import('@/lib/pane-manager/pane-manager')
const { reconcileMountedPanesToLayout } = await import('./terminal-pane-frame-reconciliation')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const TAB = 'tab-1'

const leaf = (leafId: string): TerminalPaneLayoutNode => ({ type: 'leaf', leafId })
const split = (
  direction: 'vertical' | 'horizontal',
  first: TerminalPaneLayoutNode,
  second: TerminalPaneLayoutNode,
  ratio = 0.5
): TerminalPaneLayoutNode => ({ type: 'split', direction, first, second, ratio })

describe('reconcileMountedPanesToLayout', () => {
  let root: HTMLDivElement
  let manager: InstanceType<typeof PaneManager>
  let onPaneCreated: Mock<NonNullable<PaneManagerOptions['onPaneCreated']>>
  const closePane = vi.fn()

  const reconcile = (layout: TerminalPaneLayoutNode, isExpanded = false): boolean =>
    reconcileMountedPanesToLayout({
      tabId: TAB,
      manager,
      layout: { root: layout, activeLeafId: null, expandedLeafId: null },
      closePane,
      isExpanded
    })
  const serialized = (): TerminalPaneLayoutNode | null => {
    const top = root.firstElementChild
    return top instanceof HTMLElement ? serializePaneTree(top) : null
  }
  const leaves = (): string[] => manager.getPanes().map((pane) => pane.leafId)

  beforeEach(() => {
    _resetLayoutOwnerPaneIntentsForTests()
    closePane.mockReset()
    recordCreatedTerminalPaneSplit.mockReset()
    vi.stubGlobal('requestAnimationFrame', () => 1)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    root = document.createElement('div')
    document.body.appendChild(root)
    onPaneCreated = vi.fn()
    manager = new PaneManager(root, { linkOpenHint: () => '', onPaneCreated })
    const a = manager.createInitialPane({ leafId: A })
    manager.splitPane(a.id, 'vertical', { leafId: B })
    onPaneCreated.mockClear()
  })

  afterEach(() => {
    manager.destroy()
    root.remove()
    vi.unstubAllGlobals()
  })

  it('mounts the window’s own split where main placed it, with the cwd it asked for', () => {
    expectPaneToAppear(C, {
      tabId: TAB,
      cwd: '/repo',
      telemetry: { source: 'keyboard', direction: 'horizontal' }
    })
    const layout = split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C), 0.4), 0.3)

    expect(reconcile(layout)).toBe(true)

    expect(serialized()).toEqual(layout)
    expect(onPaneCreated).toHaveBeenCalledWith(
      expect.objectContaining({ leafId: C }),
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(recordCreatedTerminalPaneSplit).toHaveBeenCalledWith(
      expect.objectContaining({ leafId: C }),
      { source: 'keyboard', direction: 'horizontal' }
    )
    expect(takePaneAppearIntent(TAB, C)).toBeNull()
  })

  it('leaves a pane main added without the window’s ask to main’s notice', () => {
    const layout = split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C)))

    expect(reconcile(layout)).toBe(false)

    expect(leaves()).toEqual([A, B])
    expect(onPaneCreated).not.toHaveBeenCalled()
  })

  it('closes a pane main dropped only when the window asked, with the close it asked for', () => {
    expect(reconcile(leaf(A))).toBe(false)
    expect(closePane).not.toHaveBeenCalled()

    expectPaneToClose(TAB, B, 'exit')
    expect(reconcile(leaf(A))).toBe(true)

    expect(closePane).toHaveBeenCalledWith(manager.getNumericIdForLeaf(B), B, 'exit')
  })

  it('keeps the last pane when main’s tree holds a pane the window has not drawn', () => {
    expectPaneToClose(TAB, A, 'user')
    manager.closePane(manager.getNumericIdForLeaf(B)!)

    expect(reconcile(leaf(C))).toBe(false)

    expect(closePane).not.toHaveBeenCalled()
    expect(leaves()).toEqual([A])
  })

  it('ignores an intent for another tab', () => {
    expectPaneToAppear(C, {
      tabId: 'tab-2',
      telemetry: { source: 'keyboard', direction: 'vertical' }
    })

    reconcile(split('vertical', leaf(A), split('vertical', leaf(B), leaf(C))))

    expect(leaves()).toEqual([A, B])
  })

  it('takes main’s ratios, then another client’s move, without recreating a pane', () => {
    const before = manager.getPanes().map((pane) => pane.container)

    // Neither adds or closes a pane: the store already holds main's tree.
    expect(reconcile(split('vertical', leaf(A), leaf(B), 0.7))).toBe(false)
    expect(serialized()).toEqual(split('vertical', leaf(A), leaf(B), 0.7))

    expect(reconcile(split('horizontal', leaf(B), leaf(A), 0.2))).toBe(false)
    expect(serialized()).toEqual(split('horizontal', leaf(B), leaf(A), 0.2))
    expect(manager.getPanes().map((pane) => pane.container)).toEqual(before)
    expect(onPaneCreated).not.toHaveBeenCalled()
  })

  it('leaves a zoomed tab’s shape for later, still mounting its own split', () => {
    expectPaneToAppear(C, {
      tabId: TAB,
      telemetry: { source: 'keyboard', direction: 'vertical' }
    })

    reconcile(split('horizontal', leaf(B), split('vertical', leaf(A), leaf(C))), true)

    expect(leaves()).toEqual([A, B, C])
  })
})
