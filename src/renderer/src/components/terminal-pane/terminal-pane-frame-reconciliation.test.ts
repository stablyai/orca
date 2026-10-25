// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { PaneManagerOptions } from '@/lib/pane-manager/pane-manager-types'
import type { TerminalPaneLayoutNode } from '../../../../shared/terminal-tab-types'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  expectPaneToClose,
  expectPaneToMountUnfocused
} from '@/runtime/layout-owner-pane-intents'
import { serializePaneTree } from './layout-serialization'

// Why: happy-dom has no canvas, so xterm cannot open; the reconciler never touches the terminal.
vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => {
  const actual: object = await importOriginal()
  return { ...actual, openTerminal: vi.fn() }
})

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

  const reconcile = (
    layout: TerminalPaneLayoutNode,
    isExpanded = false,
    ptyIdsByLeafId?: Record<string, string>
  ): boolean =>
    reconcileMountedPanesToLayout({
      tabId: TAB,
      manager,
      layout: {
        root: layout,
        activeLeafId: null,
        expandedLeafId: null,
        ...(ptyIdsByLeafId ? { ptyIdsByLeafId } : {})
      },
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

  it('mounts a pane main is starting where main placed it, starting nothing of its own', () => {
    const layout = split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C), 0.4), 0.3)

    expect(reconcile(layout)).toBe(true)

    expect(serialized()).toEqual(layout)
    // No spawn input: the pane waits on main's start, then attaches (main-pane-start-wait).
    const [created, hints] = onPaneCreated.mock.calls[0]!
    expect(created).toMatchObject({ leafId: C })
    expect(hints?.cwd).toBeUndefined()
    expect(hints?.cwdPromise).toBeUndefined()
  })

  it('mounts a pane main added that the window never asked for, attached to main’s terminal', () => {
    // Main's own split, a CLI split or another client's: the pane sets agree, none pending.
    const layout = split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C)))

    expect(reconcile(layout, false, { [C]: 'pty-main-c' })).toBe(true)

    expect(leaves()).toEqual([A, B, C])
    expect(onPaneCreated).toHaveBeenCalledTimes(1)
    expect(onPaneCreated).toHaveBeenCalledWith(
      expect.objectContaining({ leafId: C }),
      expect.objectContaining({ ptyId: 'pty-main-c' })
    )
    // The next frame finds the sets agreeing and mounts nothing again.
    expect(reconcile(layout, false, { [C]: 'pty-main-c' })).toBe(false)
    expect(onPaneCreated).toHaveBeenCalledTimes(1)
  })

  it('focuses a pane main added, as a split does', () => {
    manager.setActivePane(manager.getNumericIdForLeaf(A)!, { focus: false })

    reconcile(split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C))))

    expect(manager.getActivePane()?.leafId).toBe(C)
  })

  it('leaves focus on the source pane for the window’s startup split, as switch-off does', () => {
    manager.setActivePane(manager.getNumericIdForLeaf(A)!, { focus: false })
    expectPaneToMountUnfocused(TAB, C)

    reconcile(split('vertical', leaf(A), split('horizontal', leaf(B), leaf(C))))

    expect(leaves()).toEqual([A, B, C])
    expect(manager.getActivePane()?.leafId).toBe(A)
    // Asked once: a later pane main adds takes focus again.
    const D = '44444444-4444-4444-8444-444444444444'
    reconcile(
      split('vertical', leaf(A), split('horizontal', leaf(B), split('vertical', leaf(C), leaf(D))))
    )
    expect(manager.getActivePane()?.leafId).toBe(D)
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

  it('leaves a zoomed tab’s shape for later, still mounting main’s new pane', () => {
    reconcile(split('horizontal', leaf(B), split('vertical', leaf(A), leaf(C))), true)

    expect(leaves()).toEqual([A, B, C])
  })
})
