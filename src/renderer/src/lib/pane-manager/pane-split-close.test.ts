import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal, ScrollState } from './pane-manager-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

const captureScrollState = vi.hoisted(() => vi.fn())
const wrapInSplit = vi.hoisted(() => vi.fn())
const openTerminal = vi.hoisted(() => vi.fn())
const disposeWebgl = vi.hoisted(() => vi.fn())
const scheduleSplitScrollRestore = vi.hoisted(() => vi.fn())
const updateMultiPaneState = vi.hoisted(() => vi.fn())
const applyPaneOpacity = vi.hoisted(() => vi.fn())
const applyDividerStyles = vi.hoisted(() => vi.fn())

vi.mock('./pane-tree-ops', () => ({
  captureScrollState,
  findPaneChildren: vi.fn(),
  promoteSibling: vi.fn(),
  removeDividers: vi.fn(),
  safeFit: vi.fn(),
  wrapInSplit
}))

vi.mock('./pane-lifecycle', () => ({
  disposePane: vi.fn(),
  openTerminal
}))

vi.mock('./pane-webgl-renderer', () => ({
  disposeWebgl
}))

vi.mock('./pane-split-scroll', () => ({
  scheduleSplitScrollRestore
}))

vi.mock('./pane-drag-reorder', () => ({
  updateMultiPaneState
}))

vi.mock('./pane-divider', () => ({
  applyDividerStyles,
  applyPaneOpacity
}))

import { splitManagedPane } from './pane-split-close'

const TEST_LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId

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
    firstVisibleLineContent: `line-${viewportY}`,
    viewportY,
    totalLines: 100
  }
}

function createPane(id: number, webglAddon: unknown): ManagedPaneInternal {
  const container = new MockElement(['pane'])
  container.dataset.paneId = String(id)
  container.dataset.leafId = TEST_LEAF_ID
  return {
    id,
    leafId: TEST_LEAF_ID,
    stablePaneId: TEST_LEAF_ID,
    terminal: {
      focus: vi.fn()
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
}

describe('splitManagedPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
      managerOptions: {},
      createPaneInternal: () => {
        panes.set(newPane.id, newPane)
        return newPane
      },
      createDivider: () => new MockElement(['pane-divider']) as unknown as HTMLElement,
      publishPaneCreated: vi.fn(),
      getDragCallbacks: () => ({}) as never,
      setActivePaneId: vi.fn(),
      isDestroyed: () => false
    })

    expect(result?.id).toBe(newPane.id)
    expect(captureScrollState).toHaveBeenCalledWith(fallbackPane.terminal)
    expect(captureScrollState).toHaveBeenCalledWith(siblingPane.terminal)
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
})
