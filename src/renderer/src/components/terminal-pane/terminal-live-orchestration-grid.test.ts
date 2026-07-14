/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import { buildOrchestrationTerminalGridRoot } from '../../../../shared/orchestration-terminal-grid'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { arrangeMountedPanesAsOrchestrationGrid } from '@/lib/pane-manager/pane-orchestration-grid'
import type { ManagedPaneInternal } from '@/lib/pane-manager/pane-manager-types'
import type * as PaneLifecycleModule from '@/lib/pane-manager/pane-lifecycle'
import type * as PaneTreeOps from '@/lib/pane-manager/pane-tree-ops'
import {
  closeManagedPane,
  detachManagedPaneForExternalMove,
  splitManagedPane
} from '@/lib/pane-manager/pane-split-close'
import { isHostAuthoritativeLayout } from './terminal-live-layout-reconciliation'
import { finalizeTerminalLiveLayoutInsertions } from './terminal-live-orchestration-grid'
import { collectLeafIdsInOrder } from './terminal-layout-leaf-ids'

vi.mock('@/lib/pane-manager/pane-split-scroll', () => ({
  clearPendingSplitScrollRestore: vi.fn(),
  scheduleSplitScrollRestore: vi.fn()
}))
vi.mock('@/lib/pane-manager/pane-webgl-reattach', () => ({ reattachWebglIfNeeded: vi.fn() }))
vi.mock('@/lib/pane-manager/pane-webgl-renderer', () => ({ disposeWebgl: vi.fn() }))
const disposePane = vi.hoisted(() =>
  vi.fn((pane: ManagedPaneInternal, panes: Map<number, ManagedPaneInternal>) => {
    panes.delete(pane.id)
  })
)

vi.mock('@/lib/pane-manager/pane-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof PaneLifecycleModule>()),
  disposePane,
  openTerminal: vi.fn()
}))
vi.mock('@/lib/pane-manager/pane-tree-ops', async (importOriginal) => {
  const actual = await importOriginal<typeof PaneTreeOps>()
  return {
    ...actual,
    captureScrollState: vi.fn(() => ({ kind: 'bottom' })),
    safeFit: vi.fn()
  }
})

const LEAF_IDS = [
  '00000000-0000-4000-8000-000000000001' as TerminalLeafId,
  '00000000-0000-4000-8000-000000000002' as TerminalLeafId,
  '00000000-0000-4000-8000-000000000003' as TerminalLeafId
] as const

const TEARDOWN_LEAF_IDS = Array.from(
  { length: 7 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 11).padStart(12, '0')}` as TerminalLeafId
)

function createPane(id: number, leafId: TerminalLeafId): ManagedPaneInternal {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.leafId = leafId
  const fixture: Partial<ManagedPaneInternal> = {
    id,
    leafId,
    stablePaneId: leafId,
    container,
    terminal: { focus: vi.fn() } as never,
    webglAddon: null,
    pendingSplitScrollState: null
  }
  return fixture as ManagedPaneInternal
}

type Geometry = { x: number; width: number }

function measurePaneWidths(
  element: HTMLElement,
  geometry: Geometry,
  result = new Map<string, number>()
): Map<string, number> {
  if (element.classList.contains('pane')) {
    result.set(element.dataset.leafId!, geometry.width)
    return result
  }
  const content = [...element.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains('pane-divider')
  )
  const divider = [...element.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.classList.contains('pane-divider')
  )!
  const flex = content.map((child) => {
    const [grow = '1', , basis = '0'] = child.style.flex.split(/\s+/)
    return { grow: Number.parseFloat(grow), basis: Number.parseFloat(basis) }
  })
  const dividerWidth = Number.parseFloat(divider.style.width)
  const freeWidth = geometry.width - dividerWidth - flex[0]!.basis - flex[1]!.basis
  const firstWidth = flex[0]!.basis + (freeWidth * flex[0]!.grow) / (flex[0]!.grow + flex[1]!.grow)
  measurePaneWidths(content[0]!, { x: geometry.x, width: firstWidth }, result)
  measurePaneWidths(
    content[1]!,
    {
      x: geometry.x + firstWidth + dividerWidth,
      width: geometry.width - firstWidth - dividerWidth
    },
    result
  )
  return result
}

function gridLayout(): TerminalLayoutSnapshot {
  return {
    root: buildOrchestrationTerminalGridRoot(LEAF_IDS),
    activeLeafId: LEAF_IDS[1]!,
    expandedLeafId: null,
    layoutMode: 'orchestration-grid',
    ptyIdsByLeafId: Object.fromEntries(LEAF_IDS.map((leafId) => [leafId, `remote:env@@${leafId}`]))
  }
}

describe('finalizeTerminalLiveLayoutInsertions', () => {
  it('takes ownership and canonicalizes an ordinary mounted layout after a live grid-mode transition', () => {
    const events: string[] = []
    const setMaintainOrchestrationGrid = vi.fn(() => true)
    const arrangeOrchestrationGrid = vi.fn(() => events.push('arrange'))
    const persistLayoutSnapshot = vi.fn(() => events.push('persist'))

    finalizeTerminalLiveLayoutInsertions({
      manager: { setMaintainOrchestrationGrid, arrangeOrchestrationGrid },
      restoredLayout: gridLayout(),
      appliedInsertion: false,
      restoreActivePane: () => events.push('restore'),
      persistLayoutSnapshot
    })

    expect(setMaintainOrchestrationGrid).toHaveBeenCalledWith(true)
    expect(arrangeOrchestrationGrid).toHaveBeenCalledOnce()
    expect(events).toEqual(['restore', 'arrange'])
  })

  it('releases maintained-grid ownership on a live transition back to ordinary layout mode', () => {
    const setMaintainOrchestrationGrid = vi.fn(() => true)
    const arrangeOrchestrationGrid = vi.fn()
    const restoreActivePane = vi.fn()

    finalizeTerminalLiveLayoutInsertions({
      manager: { setMaintainOrchestrationGrid, arrangeOrchestrationGrid },
      restoredLayout: { ...gridLayout(), layoutMode: undefined },
      appliedInsertion: false,
      restoreActivePane,
      persistLayoutSnapshot: vi.fn()
    })

    expect(setMaintainOrchestrationGrid).toHaveBeenCalledWith(false)
    expect(arrangeOrchestrationGrid).not.toHaveBeenCalled()
    expect(restoreActivePane).toHaveBeenCalledOnce()
  })

  it('commits multiple host-grid insertions once after restoring canonical order and focus', () => {
    const restoredLayout = gridLayout()
    const canonicalLeafIds = collectLeafIdsInOrder(restoredLayout.root)
    expect(canonicalLeafIds).toEqual(LEAF_IDS)
    expect(
      isHostAuthoritativeLayout({
        isWebClient: false,
        ptyIdsByLeafId: restoredLayout.ptyIdsByLeafId
      })
    ).toBe(true)
    const root = document.createElement('div')
    const initialPane = createPane(1, LEAF_IDS[0]!)
    root.append(initialPane.container)
    const panes = new Map([[initialPane.id, initialPane]])
    const events: string[] = []
    let activePaneId = initialPane.id
    let nextPaneId = initialPane.id + 1
    const paneIdByLeafId = new Map<string, number>([[initialPane.leafId, initialPane.id]])
    const persistLayoutSnapshot = vi.fn(() => events.push('persist'))
    const onLayoutChanged = (): void => {
      events.push('notify')
      persistLayoutSnapshot()
    }
    const createDivider = (isVertical: boolean): HTMLElement => {
      const divider = document.createElement('div')
      divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`
      return divider
    }
    const splitWithoutCommit = (leafId: (typeof LEAF_IDS)[number]): void => {
      const created = splitManagedPane({
        paneId: initialPane.id,
        direction: 'vertical',
        opts: { leafId, activate: false, notifyLayoutChanged: false },
        panes,
        root,
        styleOptions: { dividerThicknessPx: 4 },
        managerOptions: { onLayoutChanged },
        createPaneInternal: () => {
          const pane = createPane(nextPaneId, leafId)
          nextPaneId += 1
          panes.set(pane.id, pane)
          paneIdByLeafId.set(pane.leafId, pane.id)
          return pane
        },
        createDivider,
        publishPaneCreated: vi.fn(),
        getDragCallbacks: () =>
          ({
            getPanes: () => panes,
            getRoot: () => root
          }) as never,
        getActivePaneId: () => activePaneId,
        setActivePaneId: (paneId) => {
          activePaneId = paneId ?? activePaneId
        },
        isDestroyed: () => false
      })
      expect(created?.leafId).toBe(leafId)
    }

    splitWithoutCommit(LEAF_IDS[1])
    splitWithoutCommit(LEAF_IDS[2])

    expect(events).toEqual([])
    expect(activePaneId).toBe(initialPane.id)
    const secondPaneFocus = (
      panes.get(2)!.terminal as unknown as { focus: ReturnType<typeof vi.fn> }
    ).focus
    const thirdPaneFocus = (
      panes.get(3)!.terminal as unknown as { focus: ReturnType<typeof vi.fn> }
    ).focus
    expect(secondPaneFocus).not.toHaveBeenCalled()
    expect(thirdPaneFocus).not.toHaveBeenCalled()

    const arrangeOrchestrationGrid = (leafIds?: readonly string[]): void => {
      events.push(`arrange:${panes.get(activePaneId)?.leafId}`)
      arrangeMountedPanesAsOrchestrationGrid({
        root,
        panes,
        leafIds,
        styleOptions: { dividerThicknessPx: 4 },
        isDestroyed: () => false,
        onLayoutChanged
      })
    }

    finalizeTerminalLiveLayoutInsertions({
      manager: { arrangeOrchestrationGrid, setMaintainOrchestrationGrid: vi.fn(() => false) },
      restoredLayout,
      appliedInsertion: true,
      restoreActivePane: () => {
        activePaneId = paneIdByLeafId.get(restoredLayout.activeLeafId!)!
        events.push(`restore:${panes.get(activePaneId)?.leafId}`)
      },
      persistLayoutSnapshot
    })

    expect(events).toEqual([
      `restore:${restoredLayout.activeLeafId}`,
      `arrange:${restoredLayout.activeLeafId}`,
      'notify',
      'persist'
    ])
    expect(persistLayoutSnapshot).toHaveBeenCalledOnce()
    expect(
      [...root.querySelectorAll<HTMLElement>('.pane')].map((pane) => pane.dataset.leafId)
    ).toEqual(canonicalLeafIds)
    for (const width of measurePaneWidths(root.firstElementChild as HTMLElement, {
      x: 0,
      width: 920
    }).values()) {
      expect(width).toBeCloseTo(300)
    }
  })

  it.each([
    {
      name: 'an ordinary layout',
      layout: { ...gridLayout(), layoutMode: undefined }
    },
    {
      name: 'a rootless layout',
      layout: { ...gridLayout(), root: null }
    }
  ])('persists but does not arrange $name after an insertion', ({ layout }) => {
    const arrangeOrchestrationGrid = vi.fn()
    const events: string[] = []

    finalizeTerminalLiveLayoutInsertions({
      manager: { arrangeOrchestrationGrid, setMaintainOrchestrationGrid: vi.fn(() => false) },
      restoredLayout: layout,
      appliedInsertion: true,
      restoreActivePane: () => events.push('restore'),
      persistLayoutSnapshot: () => events.push('persist')
    })

    expect(arrangeOrchestrationGrid).not.toHaveBeenCalled()
    expect(events).toEqual(['persist', 'restore'])
  })

  it('does not arrange or persist when every planned insertion is a no-op', () => {
    const arrangeOrchestrationGrid = vi.fn()
    const persistLayoutSnapshot = vi.fn()
    const restoreActivePane = vi.fn()

    finalizeTerminalLiveLayoutInsertions({
      manager: { arrangeOrchestrationGrid, setMaintainOrchestrationGrid: vi.fn(() => false) },
      restoredLayout: gridLayout(),
      appliedInsertion: false,
      restoreActivePane,
      persistLayoutSnapshot
    })

    expect(arrangeOrchestrationGrid).not.toHaveBeenCalled()
    expect(persistLayoutSnapshot).not.toHaveBeenCalled()
    expect(restoreActivePane).toHaveBeenCalledOnce()
  })
})

describe('maintained orchestration-grid teardown', () => {
  it.each(['close', 'detach'] as const)(
    'commits one canonical layout after a maintained-grid %s',
    (operation) => {
      const root = document.createElement('div')
      const panes = new Map(
        TEARDOWN_LEAF_IDS.map((leafId, index) => [index + 1, createPane(index + 1, leafId)])
      )
      arrangeMountedPanesAsOrchestrationGrid({
        root,
        panes,
        styleOptions: { dividerThicknessPx: 4 },
        isDestroyed: () => false
      })
      const events: string[] = []
      const notifiedWidths: number[][] = []
      let activePaneId: number | null = 1
      const onLayoutChanged = (): void => {
        events.push('notify')
        notifiedWidths.push([
          ...measurePaneWidths(root.firstElementChild as HTMLElement, { x: 0, width: 920 }).values()
        ])
      }
      const teardownArgs = {
        paneId: 2,
        activePaneId,
        panes,
        root,
        styleOptions: { dividerThicknessPx: 4 },
        managerOptions: {
          maintainOrchestrationGrid: true,
          onPaneClosed: () => events.push('closed'),
          onLayoutChanged
        },
        getDragCallbacks: () =>
          ({
            getPanes: () => panes,
            getRoot: () => root
          }) as never,
        releasePaneIdentity: vi.fn(),
        setActivePaneId: (paneId: number | null) => {
          activePaneId = paneId
        }
      }

      if (operation === 'close') {
        closeManagedPane(teardownArgs)
      } else {
        expect(detachManagedPaneForExternalMove(teardownArgs)).toBe(true)
      }
      events.push('arrange')
      arrangeMountedPanesAsOrchestrationGrid({
        root,
        panes,
        styleOptions: { dividerThicknessPx: 4 },
        isDestroyed: () => false,
        onLayoutChanged
      })

      expect(events).toEqual(['closed', 'arrange', 'notify'])
      expect(notifiedWidths).toHaveLength(1)
      for (const width of notifiedWidths[0]!) {
        expect(width).toBeCloseTo(145)
      }
    }
  )

  it.each(['close', 'detach'] as const)('keeps ordinary %s teardown notifications', (operation) => {
    const root = document.createElement('div')
    const panes = new Map(
      TEARDOWN_LEAF_IDS.slice(0, 2).map((leafId, index) => [
        index + 1,
        createPane(index + 1, leafId)
      ])
    )
    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      styleOptions: {},
      isDestroyed: () => false
    })
    const onLayoutChanged = vi.fn()
    const teardownArgs = {
      paneId: 2,
      activePaneId: 1,
      panes,
      root,
      styleOptions: {},
      managerOptions: { onLayoutChanged },
      getDragCallbacks: () =>
        ({
          getPanes: () => panes,
          getRoot: () => root
        }) as never,
      releasePaneIdentity: vi.fn(),
      setActivePaneId: vi.fn()
    }

    if (operation === 'close') {
      closeManagedPane(teardownArgs)
    } else {
      expect(detachManagedPaneForExternalMove(teardownArgs)).toBe(true)
    }

    expect(onLayoutChanged).toHaveBeenCalledOnce()
  })
})
