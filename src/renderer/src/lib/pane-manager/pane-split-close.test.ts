/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PaneLifecycleModule from './pane-lifecycle'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

const captureScrollState = vi.hoisted(() => vi.fn())
const restoreScrollState = vi.hoisted(() => vi.fn())
const wrapInSplit = vi.hoisted(() => vi.fn())
const openTerminal = vi.hoisted(() => vi.fn())
const disposePane = vi.hoisted(() =>
  vi.fn(
    (
      pane: ManagedPaneInternal,
      panes: Map<number, ManagedPaneInternal>,
      options?: { releaseOwnership?: boolean }
    ) => {
      if (options?.releaseOwnership !== false) {
        panes.delete(pane.id)
      }
    }
  )
)
const disposeWebgl = vi.hoisted(() => vi.fn())
const reattachWebglIfNeeded = vi.hoisted(() => vi.fn())
const clearPendingSplitScrollRestore = vi.hoisted(() => vi.fn())
const scheduleSplitScrollRestore = vi.hoisted(() => vi.fn())
const updateMultiPaneState = vi.hoisted(() => vi.fn())
const applyPaneOpacity = vi.hoisted(() => vi.fn())
const applyDividerStyles = vi.hoisted(() => vi.fn())
const disposeDivider = vi.hoisted(() => vi.fn())

vi.mock('./pane-tree-ops', () => ({
  captureScrollState,
  findPaneChildren: vi.fn(),
  promoteSibling: vi.fn(),
  removeDividers: vi.fn(),
  restoreScrollState,
  safeFit: vi.fn(),
  wrapInSplit
}))

vi.mock('./pane-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof PaneLifecycleModule>()),
  disposePane,
  openTerminal
}))

vi.mock('./pane-webgl-renderer', () => ({
  disposeWebgl
}))

vi.mock('./pane-webgl-reattach', () => ({ reattachWebglIfNeeded }))

vi.mock('./pane-split-scroll', () => ({
  clearPendingSplitScrollRestore,
  scheduleSplitScrollRestore
}))

vi.mock('./pane-drag-reorder', () => ({
  updateMultiPaneState
}))

vi.mock('./pane-divider', () => ({
  applyDividerStyles,
  applyPaneOpacity,
  disposeDivider
}))

import {
  closeManagedPane,
  detachManagedPaneForExternalMove,
  splitManagedPane
} from './pane-split-close'

const TEST_LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const paneFocusMocks = new WeakMap<ManagedPaneInternal, ReturnType<typeof vi.fn>>()

function resetDisposePaneMock(): void {
  disposePane.mockReset()
  disposePane.mockImplementation((pane, panes, options?: { releaseOwnership?: boolean }) => {
    if (options?.releaseOwnership !== false) {
      panes.delete(pane.id)
    }
  })
}

class MockElement {
  classList: { contains: (className: string) => boolean }
  dataset: Record<string, string> = {}
  parentElement: MockElement | null = null
  style: Record<string, string> = {}
  private descendants: MockElement[] = []

  constructor(private readonly classNames: string[]) {
    this.classList = {
      contains: (className: string) => this.classNames.includes(className)
    }
  }

  setQuerySelectorAllResult(descendants: MockElement[]): void {
    this.descendants = descendants
  }

  querySelectorAll(): MockElement[] {
    return this.descendants
  }
}

function createScrollState(viewportY: number): ScrollState {
  return {
    bufferType: 'normal',
    wasAtBottom: false,
    viewportY,
    baseY: 100
  }
}

function createPane(id: number, webglAddon: unknown): ManagedPaneInternal {
  const container = new MockElement(['pane'])
  container.dataset.paneId = String(id)
  container.dataset.leafId = TEST_LEAF_ID
  const focus = vi.fn()
  const pane: ManagedPaneInternal = {
    id,
    leafId: TEST_LEAF_ID,
    stablePaneId: TEST_LEAF_ID,
    terminal: {
      focus
    } as never,
    container: container as unknown as HTMLElement,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: webglAddon as never,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    fitAddon: {} as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
  paneFocusMocks.set(pane, focus)
  return pane
}

function createDomPane(id: number, webglAddon: unknown): ManagedPaneInternal {
  const pane = createPane(id, webglAddon)
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)
  container.dataset.leafId = TEST_LEAF_ID
  pane.container = container
  return pane
}

function installDomWrap(): void {
  wrapInSplit.mockImplementationOnce(
    (
      existingContainer: HTMLElement,
      newContainer: HTMLElement,
      isVertical: boolean,
      divider: HTMLElement
    ) => {
      const parent = existingContainer.parentElement!
      const split = document.createElement('div')
      split.className = `pane-split ${isVertical ? 'is-vertical' : 'is-horizontal'}`
      parent.replaceChild(split, existingContainer)
      split.append(existingContainer, divider, newContainer)
    }
  )
}

describe('splitManagedPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDisposePaneMock()
  })

  it.each([
    { activate: false, expectedActivePaneId: 1, expectedFocusCalls: 0 },
    { activate: true, expectedActivePaneId: 2, expectedFocusCalls: 1 }
  ])(
    'honors activate:$activate while suppressing the grid transaction notification',
    ({ activate, expectedActivePaneId, expectedFocusCalls }) => {
      const existingPane = createPane(1, null)
      const newPane = createPane(2, null)
      const panes = new Map<number, ManagedPaneInternal>([[existingPane.id, existingPane]])
      const root = new MockElement(['root'])
      const existingContainer = existingPane.container as unknown as MockElement
      existingContainer.parentElement = root
      let activePaneId = existingPane.id
      const onLayoutChanged = vi.fn()

      const result = splitManagedPane({
        paneId: existingPane.id,
        direction: 'vertical',
        opts: { activate, notifyLayoutChanged: false },
        panes,
        root: root as unknown as HTMLElement,
        styleOptions: {},
        managerOptions: { onLayoutChanged },
        createPaneInternal: () => {
          panes.set(newPane.id, newPane)
          return newPane
        },
        createDivider: () => new MockElement(['pane-divider']) as unknown as HTMLElement,
        publishPaneCreated: vi.fn(),
        getDragCallbacks: () => ({}) as never,
        getActivePaneId: () => activePaneId,
        setActivePaneId: (paneId) => {
          activePaneId = paneId ?? activePaneId
        },
        isDestroyed: () => false
      })

      expect(result?.id).toBe(newPane.id)
      expect(activePaneId).toBe(expectedActivePaneId)
      expect(paneFocusMocks.get(newPane)).toHaveBeenCalledTimes(expectedFocusCalls)
      expect(applyPaneOpacity).toHaveBeenLastCalledWith(
        expect.anything(),
        expectedActivePaneId,
        expect.anything()
      )
      expect(onLayoutChanged).not.toHaveBeenCalled()
    }
  )

  it('prepares every pane under a moved mounted subtree for split reparenting', () => {
    const fallbackPane = createPane(1, { dispose: vi.fn() })
    const siblingPane = createPane(2, { dispose: vi.fn() })
    const newPane = createPane(3, null)
    const panes = new Map<number, ManagedPaneInternal>([
      [fallbackPane.id, fallbackPane],
      [siblingPane.id, siblingPane]
    ])
    const root = new MockElement(['root'])
    const sourceContainer = new MockElement(['pane-split'])
    sourceContainer.parentElement = root
    sourceContainer.setQuerySelectorAllResult([
      fallbackPane.container as unknown as MockElement,
      siblingPane.container as unknown as MockElement
    ])
    const fallbackScrollState = createScrollState(11)
    const siblingScrollState = createScrollState(22)
    captureScrollState
      .mockReturnValueOnce(fallbackScrollState)
      .mockReturnValueOnce(siblingScrollState)

    const result = splitManagedPane({
      paneId: fallbackPane.id,
      direction: 'vertical',
      sourceContainer: sourceContainer as unknown as HTMLElement,
      panes,
      root: root as unknown as HTMLElement,
      styleOptions: {},
      managerOptions: { linkOpenHint: () => '' },
      createPaneInternal: () => {
        panes.set(newPane.id, newPane)
        return newPane
      },
      createDivider: () => new MockElement(['pane-divider']) as unknown as HTMLElement,
      publishPaneCreated: vi.fn(),
      getDragCallbacks: () => ({}) as never,
      getActivePaneId: () => fallbackPane.id,
      setActivePaneId: vi.fn(),
      isDestroyed: () => false
    })

    expect(result?.id).toBe(newPane.id)
    expect(captureScrollState).toHaveBeenCalledWith(fallbackPane.terminal)
    expect(captureScrollState).toHaveBeenCalledWith(siblingPane.terminal)
    expect(clearPendingSplitScrollRestore).toHaveBeenCalledWith(fallbackPane)
    expect(clearPendingSplitScrollRestore).toHaveBeenCalledWith(siblingPane)
    expect(fallbackPane.pendingSplitScrollState).toBe(fallbackScrollState)
    expect(siblingPane.pendingSplitScrollState).toBe(siblingScrollState)
    expect(disposeWebgl).toHaveBeenCalledWith(fallbackPane)
    expect(disposeWebgl).toHaveBeenCalledWith(siblingPane)
    expect(wrapInSplit).toHaveBeenCalledWith(
      sourceContainer,
      newPane.container,
      true,
      expect.anything(),
      undefined
    )
    expect(scheduleSplitScrollRestore).toHaveBeenCalledTimes(2)
    expect(scheduleSplitScrollRestore).toHaveBeenNthCalledWith(
      1,
      expect.any(Function),
      fallbackPane.id,
      fallbackScrollState,
      expect.any(Function),
      expect.any(Function)
    )
    expect(scheduleSplitScrollRestore).toHaveBeenNthCalledWith(
      2,
      expect.any(Function),
      siblingPane.id,
      siblingScrollState,
      expect.any(Function),
      expect.any(Function)
    )
  })

  it('removes a partially opened pane and restores the prior tree when terminal open throws', () => {
    const existingPane = createDomPane(1, { dispose: vi.fn() })
    const newPane = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([[existingPane.id, existingPane]])
    const root = document.createElement('div')
    root.append(existingPane.container)
    let activePaneId: number | null = existingPane.id
    const scrollState = createScrollState(17)
    captureScrollState.mockReturnValueOnce(scrollState)
    installDomWrap()
    openTerminal.mockImplementationOnce(() => {
      throw new Error('terminal open failed')
    })

    expect(() =>
      splitManagedPane({
        paneId: existingPane.id,
        direction: 'vertical',
        panes,
        root,
        styleOptions: {},
        managerOptions: {},
        createPaneInternal: () => {
          panes.set(newPane.id, newPane)
          return newPane
        },
        createDivider: () => {
          const divider = document.createElement('div')
          divider.className = 'pane-divider'
          return divider
        },
        publishPaneCreated: vi.fn(),
        getDragCallbacks: () => ({}) as never,
        getActivePaneId: () => activePaneId,
        setActivePaneId: (paneId) => {
          activePaneId = paneId
        },
        isDestroyed: () => false
      })
    ).toThrow('terminal open failed')

    expect([...panes.keys()]).toEqual([existingPane.id])
    expect(root.firstElementChild).toBe(existingPane.container)
    expect(root.querySelectorAll('.pane')).toHaveLength(1)
    expect(activePaneId).toBe(existingPane.id)
    expect(disposePane).toHaveBeenCalledWith(newPane, panes, { releaseOwnership: false })
    expect(restoreScrollState).toHaveBeenCalledWith(existingPane.terminal, scrollState)
    expect(reattachWebglIfNeeded).toHaveBeenCalledWith(existingPane)
    expect(scheduleSplitScrollRestore).not.toHaveBeenCalled()
  })

  it('runs lifecycle compensation when pane publication throws after resources exist', () => {
    const existingPane = createDomPane(1, null)
    const newPane = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([[existingPane.id, existingPane]])
    const root = document.createElement('div')
    root.append(existingPane.container)
    const resources = {
      domListeners: 0,
      launchConfigs: 0,
      parsers: 0,
      ptys: 0,
      timers: 0
    }
    const onPaneClosed = vi.fn(() => {
      for (const key of Object.keys(resources) as (keyof typeof resources)[]) {
        resources[key] = 0
      }
    })
    captureScrollState.mockReturnValueOnce(createScrollState(9))
    installDomWrap()

    expect(() =>
      splitManagedPane({
        paneId: existingPane.id,
        direction: 'vertical',
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed },
        createPaneInternal: () => {
          panes.set(newPane.id, newPane)
          return newPane
        },
        createDivider: () => document.createElement('div'),
        publishPaneCreated: () => {
          for (const key of Object.keys(resources) as (keyof typeof resources)[]) {
            resources[key] = 1
          }
          throw new Error('pane publication failed')
        },
        getDragCallbacks: () => ({}) as never,
        getActivePaneId: () => existingPane.id,
        setActivePaneId: vi.fn(),
        isDestroyed: () => false
      })
    ).toThrow('pane publication failed')

    expect(onPaneClosed).toHaveBeenCalledOnce()
    expect(onPaneClosed).toHaveBeenCalledWith(newPane.id, {
      paneId: newPane.id,
      leafId: newPane.leafId,
      reason: 'close'
    })
    expect(resources).toEqual({
      domListeners: 0,
      launchConfigs: 0,
      parsers: 0,
      ptys: 0,
      timers: 0
    })
    expect([...panes.keys()]).toEqual([existingPane.id])
    expect(root.firstElementChild).toBe(existingPane.container)
  })

  it('retries pane and published-resource cleanup before releasing partial split ownership', () => {
    const existingPane = createDomPane(1, null)
    const newPane = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([[existingPane.id, existingPane]])
    const root = document.createElement('div')
    root.append(existingPane.container)
    let paneCloseObservedOwnership = false
    const onPaneClosed = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        paneCloseObservedOwnership =
          panes.get(newPane.id) === newPane && newPane.container.parentElement !== null
        throw new Error('published resource cleanup failed')
      })
      .mockImplementationOnce(() => undefined)
    captureScrollState.mockReturnValueOnce(createScrollState(13))
    installDomWrap()
    let paneDisposeObservedOwnership = false
    disposePane
      .mockImplementationOnce(() => {
        paneDisposeObservedOwnership =
          panes.get(newPane.id) === newPane && newPane.container.parentElement !== null
        throw new Error('pane cleanup failed')
      })
      .mockImplementationOnce(() => undefined)

    expect(() =>
      splitManagedPane({
        paneId: existingPane.id,
        direction: 'vertical',
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed },
        createPaneInternal: () => {
          panes.set(newPane.id, newPane)
          return newPane
        },
        createDivider: () => document.createElement('div'),
        publishPaneCreated: () => {
          throw new Error('pane publication failed')
        },
        getDragCallbacks: () => ({}) as never,
        getActivePaneId: () => existingPane.id,
        setActivePaneId: vi.fn(),
        isDestroyed: () => false
      })
    ).toThrow('pane publication failed')

    expect([...panes.keys()]).toEqual([existingPane.id])
    expect(newPane.container.parentElement).toBeNull()
    expect(root.firstElementChild).toBe(existingPane.container)
    expect(paneDisposeObservedOwnership).toBe(true)
    expect(paneCloseObservedOwnership).toBe(true)
    expect(disposePane).toHaveBeenCalledTimes(2)
    expect(onPaneClosed).toHaveBeenCalledTimes(2)
    expect(updateMultiPaneState).toHaveBeenCalled()
  })

  it('keeps a partial pane mapped and mounted when both cleanup attempts fail', () => {
    const existingPane = createDomPane(1, null)
    const newPane = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([[existingPane.id, existingPane]])
    const root = document.createElement('div')
    root.append(existingPane.container)
    captureScrollState.mockReturnValueOnce(createScrollState(13))
    installDomWrap()
    disposePane.mockImplementation(() => {
      throw new Error('persistent pane cleanup failed')
    })
    const onPaneClosed = vi.fn(() => {
      throw new Error('persistent published cleanup failed')
    })

    let failure: unknown
    try {
      splitManagedPane({
        paneId: existingPane.id,
        direction: 'vertical',
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed },
        createPaneInternal: () => {
          panes.set(newPane.id, newPane)
          return newPane
        },
        createDivider: () => document.createElement('div'),
        publishPaneCreated: () => {
          throw new Error('pane publication failed')
        },
        getDragCallbacks: () => ({}) as never,
        getActivePaneId: () => existingPane.id,
        setActivePaneId: vi.fn(),
        isDestroyed: () => false
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as Error).message).toContain('pane publication failed')
    expect((failure as Error).message).toContain('split rollback')
    expect(panes.get(newPane.id)).toBe(newPane)
    expect(newPane.container.parentElement).not.toBeNull()
    expect(disposePane).toHaveBeenCalledTimes(2)
    expect(onPaneClosed).toHaveBeenCalledTimes(2)
  })
})

describe('closeManagedPane fault isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetDisposePaneMock()
  })

  it('retains map, DOM, and identity until a throwing pane disposer succeeds on retry', () => {
    const survivor = createDomPane(1, null)
    const closing = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([
      [survivor.id, survivor],
      [closing.id, closing]
    ])
    const root = document.createElement('div')
    root.append(survivor.container, closing.container)
    let releaseObservedLivePane = true
    const releasePaneIdentity = vi.fn(() => {
      releaseObservedLivePane = panes.has(closing.id) || closing.container.parentElement !== null
    })
    const onPaneClosed = vi.fn()
    disposePane
      .mockImplementationOnce(() => {
        throw new Error('pane disposer failed')
      })
      .mockImplementationOnce(() => undefined)

    expect(() =>
      closeManagedPane({
        paneId: closing.id,
        activePaneId: survivor.id,
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed },
        getDragCallbacks: () => ({}) as never,
        releasePaneIdentity,
        setActivePaneId: vi.fn()
      })
    ).toThrow('pane disposer failed')

    expect(panes.has(closing.id)).toBe(true)
    expect(closing.container.parentElement).toBe(root)
    expect(releasePaneIdentity).not.toHaveBeenCalled()
    expect(onPaneClosed).toHaveBeenCalledOnce()

    expect(() =>
      closeManagedPane({
        paneId: closing.id,
        activePaneId: survivor.id,
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed },
        getDragCallbacks: () => ({}) as never,
        releasePaneIdentity,
        setActivePaneId: vi.fn()
      })
    ).not.toThrow()
    expect(disposePane).toHaveBeenCalledTimes(2)
    expect(onPaneClosed).toHaveBeenCalledOnce()
    expect(panes.has(closing.id)).toBe(false)
    expect(closing.container.parentElement).toBeNull()
    expect(releasePaneIdentity).toHaveBeenCalledOnce()
    expect(releaseObservedLivePane).toBe(false)
  })

  it('defers ownership release and layout notification until published-resource cleanup retries', () => {
    const survivor = createDomPane(1, null)
    const closing = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([
      [survivor.id, survivor],
      [closing.id, closing]
    ])
    const root = document.createElement('div')
    root.append(survivor.container, closing.container)
    const onLayoutChanged = vi.fn()
    const releasePaneIdentity = vi.fn()
    const onPaneClosed = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('published cleanup failed')
      })
      .mockImplementationOnce(() => undefined)

    expect(() =>
      closeManagedPane({
        paneId: closing.id,
        activePaneId: survivor.id,
        panes,
        root,
        styleOptions: {},
        managerOptions: {
          onPaneClosed,
          onLayoutChanged
        },
        getDragCallbacks: () => ({}) as never,
        releasePaneIdentity,
        setActivePaneId: vi.fn()
      })
    ).toThrow('published cleanup failed')

    expect(panes.has(closing.id)).toBe(true)
    expect(closing.container.parentElement).toBe(root)
    expect(releasePaneIdentity).not.toHaveBeenCalled()
    expect(onLayoutChanged).not.toHaveBeenCalled()

    expect(() =>
      closeManagedPane({
        paneId: closing.id,
        activePaneId: survivor.id,
        panes,
        root,
        styleOptions: {},
        managerOptions: { onPaneClosed, onLayoutChanged },
        getDragCallbacks: () => ({}) as never,
        releasePaneIdentity,
        setActivePaneId: vi.fn()
      })
    ).not.toThrow()
    expect(onPaneClosed).toHaveBeenCalledTimes(2)
    expect(panes.has(closing.id)).toBe(false)
    expect(closing.container.parentElement).toBeNull()
    expect(releasePaneIdentity).toHaveBeenCalledOnce()
    expect(onLayoutChanged).toHaveBeenCalledOnce()
  })

  it('resumes detach post-cleanup after the pane has already left the map and DOM', () => {
    const survivor = createDomPane(1, null)
    const detached = createDomPane(2, null)
    const panes = new Map<number, ManagedPaneInternal>([
      [survivor.id, survivor],
      [detached.id, detached]
    ])
    const root = document.createElement('div')
    root.append(survivor.container, detached.container)
    const releasePaneIdentity = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('identity release failed')
      })
      .mockImplementationOnce(() => undefined)
    const args = {
      paneId: detached.id,
      activePaneId: survivor.id,
      panes,
      root,
      styleOptions: {},
      managerOptions: {},
      getDragCallbacks: () => ({}) as never,
      releasePaneIdentity,
      setActivePaneId: vi.fn()
    }

    expect(() => detachManagedPaneForExternalMove(args)).toThrow('identity release failed')
    expect(panes.has(detached.id)).toBe(false)
    expect(detached.container.parentElement).toBeNull()

    expect(detachManagedPaneForExternalMove(args)).toBe(true)
    expect(releasePaneIdentity).toHaveBeenCalledTimes(2)
  })
})
