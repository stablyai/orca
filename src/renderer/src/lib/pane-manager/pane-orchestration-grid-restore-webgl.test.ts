/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as PaneLifecycleModule from './pane-lifecycle'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'

const captureScrollState = vi.hoisted(() =>
  vi.fn(
    (): ScrollState => ({
      bufferType: 'normal',
      wasAtBottom: true,
      viewportY: 0,
      baseY: 0
    })
  )
)
const restoreScrollState = vi.hoisted(() => vi.fn())
const releaseScrollStateMarker = vi.hoisted(() => vi.fn())
const attachWebgl = vi.hoisted(() =>
  vi.fn((pane: { webglAddon: unknown }) => {
    pane.webglAddon = { dispose: vi.fn() }
  })
)
const disposeWebgl = vi.hoisted(() =>
  vi.fn((pane: { webglAddon: unknown }) => {
    pane.webglAddon = null
  })
)
const linkOpenHint = vi.hoisted(() => vi.fn(() => ''))

vi.mock('./pane-scroll', () => ({
  captureScrollState,
  releaseScrollStateMarker,
  restoreScrollState
}))
vi.mock('./pane-lifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof PaneLifecycleModule>()),
  disposePane: vi.fn(),
  openTerminal: vi.fn()
}))
vi.mock('./pane-webgl-renderer', () => ({
  attachWebgl,
  clearTerminalWebglAttachBackoff: vi.fn(),
  disposeWebgl
}))
vi.mock('./pane-drag-reorder', () => ({ updateMultiPaneState: vi.fn() }))

import { replayTerminalLayout } from '../../components/terminal-pane/layout-serialization'
import { arrangeMountedPanesAsOrchestrationGrid } from './pane-orchestration-grid'
import { splitManagedPane } from './pane-split-close'

const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222' as TerminalLeafId

function createPane(id: number, leafId: TerminalLeafId, hasWebgl: boolean): ManagedPaneInternal {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(id)
  container.dataset.leafId = leafId
  const fixture: Partial<ManagedPaneInternal> = {
    id,
    leafId,
    stablePaneId: leafId,
    container,
    terminal: {
      cols: 80,
      rows: 24,
      focus: vi.fn(),
      refresh: vi.fn(),
      buffer: {
        active: { type: 'normal', length: 24 },
        onBufferChange: vi.fn()
      }
    } as never,
    xtermContainer: document.createElement('div'),
    linkTooltip: document.createElement('div'),
    terminalGpuAcceleration: hasWebgl ? 'on' : 'off',
    gpuRenderingEnabled: hasWebgl,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: hasWebgl ? ({ dispose: vi.fn() } as never) : null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    fitAddon: { proposeDimensions: vi.fn(() => null), fit: vi.fn() } as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    pendingSplitScrollState: null,
    pendingSplitScrollRafIds: [],
    pendingSplitScrollTimerId: null,
    pendingSplitScrollBufferDisposable: null,
    pendingSplitWebglReattach: false,
    debugLabel: null
  }
  return fixture as ManagedPaneInternal
}

describe('orchestration-grid restore WebGL lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      setTimeout(() => callback(16), 16)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('reattaches an original GPU pane once after binary replay and grid arrange settle', () => {
    const root = document.createElement('div')
    const originalPane = createPane(1, FIRST_LEAF_ID, true)
    const createdPane = createPane(2, SECOND_LEAF_ID, false)
    const panes = new Map<number, ManagedPaneInternal>()
    let splitTimerId: ReturnType<typeof setTimeout> | null | undefined
    let arrangedTimerId: ReturnType<typeof setTimeout> | null | undefined
    const createDivider = (isVertical: boolean): HTMLElement => {
      const divider = document.createElement('div')
      divider.className = `pane-divider ${isVertical ? 'is-vertical' : 'is-horizontal'}`
      return divider
    }
    const manager = {
      createInitialPane: vi.fn(() => {
        panes.set(originalPane.id, originalPane)
        root.append(originalPane.container)
        return originalPane
      }),
      splitPane: vi.fn(
        (paneId: number, direction: 'vertical' | 'horizontal', opts?: { leafId?: string }) => {
          const result = splitManagedPane({
            paneId,
            direction,
            opts,
            panes,
            root,
            styleOptions: {},
            managerOptions: { linkOpenHint },
            createPaneInternal: () => {
              panes.set(createdPane.id, createdPane)
              return createdPane
            },
            createDivider,
            publishPaneCreated: vi.fn(),
            getDragCallbacks: () => ({}) as never,
            setActivePaneId: vi.fn(),
            isDestroyed: () => false
          })
          splitTimerId = originalPane.pendingSplitScrollTimerId
          return result
        }
      ),
      arrangeOrchestrationGrid: vi.fn((leafIds: readonly string[]) => {
        arrangeMountedPanesAsOrchestrationGrid({
          root,
          panes,
          leafIds,
          styleOptions: {},
          isDestroyed: () => false
        })
        arrangedTimerId = originalPane.pendingSplitScrollTimerId
      })
    }
    const snapshot: TerminalLayoutSnapshot = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: FIRST_LEAF_ID },
        second: { type: 'leaf', leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: FIRST_LEAF_ID,
      layoutMode: 'orchestration-grid'
    }

    const restored = replayTerminalLayout(
      manager as unknown as Parameters<typeof replayTerminalLayout>[0],
      snapshot,
      false
    )

    expect([...restored.keys()]).toEqual([FIRST_LEAF_ID, SECOND_LEAF_ID])
    expect(splitTimerId).not.toBeNull()
    expect(arrangedTimerId).not.toBeNull()
    expect(arrangedTimerId).not.toBe(splitTimerId)
    expect(originalPane.pendingSplitWebglReattach).toBe(true)
    expect(attachWebgl).not.toHaveBeenCalled()

    vi.advanceTimersByTime(200)

    expect(attachWebgl).toHaveBeenCalledOnce()
    expect(attachWebgl).toHaveBeenCalledWith(originalPane)
    expect(originalPane.webglAddon).not.toBeNull()
    expect(originalPane.pendingSplitWebglReattach).toBe(false)
    expect(originalPane.pendingSplitScrollState).toBeNull()
    expect(originalPane.pendingSplitScrollTimerId).toBeNull()
    expect(originalPane.pendingSplitScrollRafIds).toEqual([])
    expect(createdPane.pendingSplitScrollState).toBeNull()
    expect(createdPane.pendingSplitScrollTimerId).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
