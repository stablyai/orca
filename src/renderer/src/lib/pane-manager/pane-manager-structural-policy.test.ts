/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'

const splitManagedPane = vi.hoisted(() => vi.fn(() => ({ id: 3 })))
const splitPaneAroundMountedSubtree = vi.hoisted(() => vi.fn(() => ({ id: 3 })))
const equalizePaneSplitSizes = vi.hoisted(() => vi.fn(() => true))
const handlePaneDrop = vi.hoisted(() => vi.fn())
const beginPaneDragFromPointerDown = vi.hoisted(() => vi.fn())
const closeManagedPane = vi.hoisted(() => vi.fn())
const detachManagedPaneForExternalMove = vi.hoisted(() => vi.fn(() => true))
const arrangeMountedPanesAsOrchestrationGrid = vi.hoisted(() => vi.fn())
const linkOpenHint = vi.hoisted(() => vi.fn(() => ''))

vi.mock('./pane-split-close', () => ({
  closeManagedPane,
  detachManagedPaneForExternalMove,
  splitManagedPane
}))
vi.mock('./pane-subtree-split', () => ({ splitPaneAroundMountedSubtree }))
vi.mock('./pane-tree-ops', () => ({
  equalizePaneSplitSizes,
  fitAllPanesInternal: vi.fn(),
  refitPanesUnder: vi.fn(),
  safeFit: vi.fn()
}))
vi.mock('./pane-drag-reorder', () => ({
  cancelActivePaneDrag: vi.fn(),
  createDragReorderState: vi.fn(() => ({
    dragSourcePaneId: null,
    dropOverlay: null,
    currentDropTarget: null,
    currentExternalDropTarget: null,
    cleanupActiveDrag: null
  })),
  handlePaneDrop
}))
vi.mock('./pane-drag-pointer', () => ({ beginPaneDragFromPointerDown }))
vi.mock('./pane-manager-registry', () => ({
  registerLivePaneManager: vi.fn(),
  unregisterLivePaneManager: vi.fn()
}))
vi.mock('./pane-orchestration-grid', () => ({ arrangeMountedPanesAsOrchestrationGrid }))

import { PaneManager } from './pane-manager'

function seedTwoPanes(manager: PaneManager): void {
  const panes = (manager as unknown as { panes: Map<number, ManagedPaneInternal> }).panes
  panes.set(1, { id: 1 } as ManagedPaneInternal)
  panes.set(2, { id: 2 } as ManagedPaneInternal)
}

describe('PaneManager maintained-grid structural policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('ignores manual split, equalize, pane move, and title drag while grid maintenance owns structure', () => {
    const onLayoutChanged = vi.fn()
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      maintainOrchestrationGrid: true,
      onLayoutChanged
    })
    seedTwoPanes(manager)
    const handle = document.createElement('div')
    const pointerEvent = new PointerEvent('pointerdown', { button: 0 })

    expect(manager.splitPane(1, 'vertical')).toBeNull()
    expect(manager.splitPaneAroundLeafIds(['leaf-1'], 1, 'vertical')).toBeNull()
    manager.equalizePaneSizes()
    manager.movePane(1, 2, 'right')
    manager.beginPaneDragFromPointerDown(1, handle, pointerEvent)

    expect(splitManagedPane).not.toHaveBeenCalled()
    expect(splitPaneAroundMountedSubtree).not.toHaveBeenCalled()
    expect(equalizePaneSplitSizes).not.toHaveBeenCalled()
    expect(handlePaneDrop).not.toHaveBeenCalled()
    expect(beginPaneDragFromPointerDown).not.toHaveBeenCalled()
    expect(onLayoutChanged).not.toHaveBeenCalled()
  })

  it('keeps the same structural actions available on ordinary terminal tabs', () => {
    const onLayoutChanged = vi.fn()
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      onLayoutChanged
    })
    seedTwoPanes(manager)

    expect(manager.splitPane(1, 'vertical')).toEqual({ id: 3 })
    expect(manager.splitPaneAroundLeafIds(['leaf-1'], 1, 'vertical')).toEqual({ id: 3 })
    manager.equalizePaneSizes()
    manager.movePane(1, 2, 'right')
    manager.beginPaneDragFromPointerDown(
      1,
      document.createElement('div'),
      new PointerEvent('pointerdown', { button: 0 })
    )

    expect(splitManagedPane).toHaveBeenCalledOnce()
    expect(splitPaneAroundMountedSubtree).toHaveBeenCalledOnce()
    expect(equalizePaneSplitSizes).toHaveBeenCalledOnce()
    expect(handlePaneDrop).toHaveBeenCalledOnce()
    expect(beginPaneDragFromPointerDown).toHaveBeenCalledOnce()
    expect(onLayoutChanged).toHaveBeenCalledOnce()
  })

  it('allows an explicitly sanctioned orchestration insertion to reach the split owner', () => {
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      maintainOrchestrationGrid: true
    })
    seedTwoPanes(manager)

    expect(
      manager.splitPane(1, 'vertical', {
        allowOrchestrationGridMutation: true,
        notifyLayoutChanged: false
      })
    ).toEqual({ id: 3 })

    expect(splitManagedPane).toHaveBeenCalledOnce()
    expect(splitManagedPane).toHaveBeenCalledWith(
      expect.objectContaining({
        opts: expect.objectContaining({
          allowOrchestrationGridMutation: true,
          notifyLayoutChanged: false
        })
      })
    )
  })

  it('allows maintained-grid title drag when it can detach to an external tab target', () => {
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      maintainOrchestrationGrid: true,
      resolveExternalPaneDropTarget: vi.fn(() => null),
      onExternalPaneDrop: vi.fn()
    })
    seedTwoPanes(manager)

    manager.beginPaneDragFromPointerDown(
      1,
      document.createElement('div'),
      new PointerEvent('pointerdown', { button: 0 })
    )

    expect(beginPaneDragFromPointerDown).toHaveBeenCalledOnce()
  })

  it.each(['close', 'detach'] as const)(
    'reflows a canonical grid after an ordinary mount changes live ownership and then %s runs',
    (operation) => {
      const manager = new PaneManager(document.createElement('div'), { linkOpenHint })

      expect(manager.setMaintainOrchestrationGrid(true)).toBe(true)
      expect(arrangeMountedPanesAsOrchestrationGrid).toHaveBeenCalledOnce()
      arrangeMountedPanesAsOrchestrationGrid.mockClear()
      if (operation === 'close') {
        manager.closePane(1)
        expect(closeManagedPane).toHaveBeenCalledOnce()
      } else {
        expect(manager.detachPaneForExternalMove(1)).toBe(true)
        expect(detachManagedPaneForExternalMove).toHaveBeenCalledOnce()
      }

      expect(arrangeMountedPanesAsOrchestrationGrid).toHaveBeenCalledOnce()
    }
  )

  it.each(['close', 'detach'] as const)(
    'does not rebuild a maintained grid around a retained pane when %s cleanup pauses',
    (operation) => {
      const manager = new PaneManager(document.createElement('div'), {
        linkOpenHint,
        maintainOrchestrationGrid: true
      })
      seedTwoPanes(manager)
      const cleanupPending = new Error('PTY destroy is still pending')

      if (operation === 'close') {
        closeManagedPane.mockImplementationOnce(() => {
          throw cleanupPending
        })
        expect(() => manager.closePane(1)).toThrow(cleanupPending)
      } else {
        detachManagedPaneForExternalMove.mockImplementationOnce(() => {
          throw cleanupPending
        })
        expect(() => manager.detachPaneForExternalMove(1)).toThrow(cleanupPending)
      }

      expect(arrangeMountedPanesAsOrchestrationGrid).not.toHaveBeenCalled()
    }
  )

  it('rebuilds a maintained grid when close post-cleanup fails after releasing structure', () => {
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      maintainOrchestrationGrid: true
    })
    seedTwoPanes(manager)
    const panes = (manager as unknown as { panes: Map<number, ManagedPaneInternal> }).panes
    const cleanupFailure = new Error('post-cleanup failed')
    closeManagedPane.mockImplementationOnce(() => {
      panes.delete(1)
      throw cleanupFailure
    })

    expect(() => manager.closePane(1)).toThrow(cleanupFailure)
    expect(arrangeMountedPanesAsOrchestrationGrid).toHaveBeenCalledOnce()
  })

  it('restores interactive ordinary dividers when live grid ownership is released', () => {
    const root = document.createElement('div')
    const split = document.createElement('div')
    split.className = 'pane-split is-vertical'
    const first = document.createElement('div')
    const maintainedDivider = document.createElement('div')
    maintainedDivider.className = 'pane-divider is-vertical'
    maintainedDivider.style.pointerEvents = 'none'
    const second = document.createElement('div')
    split.append(first, maintainedDivider, second)
    root.append(split)
    const manager = new PaneManager(root, { linkOpenHint, maintainOrchestrationGrid: true })

    expect(manager.setMaintainOrchestrationGrid(false)).toBe(true)

    const ordinaryDivider = split.querySelector<HTMLElement>('.pane-divider')!
    expect(ordinaryDivider).not.toBe(maintainedDivider)
    expect(ordinaryDivider.style.pointerEvents).toBe('')
    expect(ordinaryDivider.style.cursor).toBe('col-resize')
  })

  it('publishes the surviving active pane only after close selects it', () => {
    const onActivePaneChange = vi.fn()
    const manager = new PaneManager(document.createElement('div'), {
      linkOpenHint,
      onActivePaneChange
    })
    const panes = (manager as unknown as { panes: Map<number, ManagedPaneInternal> }).panes
    const createPane = (id: number, leafId: string): ManagedPaneInternal =>
      ({
        id,
        leafId,
        stablePaneId: leafId,
        terminal: { focus: vi.fn() },
        container: document.createElement('div'),
        linkTooltip: document.createElement('div'),
        fitAddon: {},
        searchAddon: {},
        serializeAddon: {}
      }) as unknown as ManagedPaneInternal
    panes.set(1, createPane(1, '40000000-0000-4000-8000-000000000001'))
    panes.set(2, createPane(2, '40000000-0000-4000-8000-000000000002'))
    ;(manager as unknown as { activePaneId: number | null }).activePaneId = 1
    closeManagedPane.mockImplementationOnce((args) => args.setActivePaneId(2))

    manager.closePane(1)

    expect(manager.getActivePane()?.id).toBe(2)
    expect(onActivePaneChange).toHaveBeenCalledOnce()
    expect(onActivePaneChange).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }))
  })

  it('retains leaf ownership for a partial split pane that still needs cleanup', () => {
    const manager = new PaneManager(document.createElement('div'), { linkOpenHint })
    const leafId = '40000000-0000-4000-8000-000000000003'
    const internal = manager as unknown as {
      panes: Map<number, ManagedPaneInternal>
      nextPaneId: number
      identities: {
        register: (paneId: number, leafId: string) => void
      }
      releaseFailedSplitIdentities: (firstCreatedPaneId: number) => void
    }
    internal.identities.register(3, leafId)
    internal.panes.set(3, { id: 3 } as ManagedPaneInternal)
    internal.nextPaneId = 4

    internal.releaseFailedSplitIdentities(3)
    expect(manager.getNumericIdForLeaf(leafId)).toBe(3)

    internal.panes.delete(3)
    internal.releaseFailedSplitIdentities(3)
    expect(manager.getNumericIdForLeaf(leafId)).toBeNull()
  })
})
