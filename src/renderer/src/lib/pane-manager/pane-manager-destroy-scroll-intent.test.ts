import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

const clearTerminalScrollIntentKey = vi.hoisted(() => vi.fn())
const disposePane = vi.hoisted(() => vi.fn())

vi.mock('./terminal-scroll-intent', () => ({
  clearTerminalScrollIntentKey
}))

vi.mock('./pane-lifecycle', () => ({
  createPaneDOM: vi.fn(),
  disposePane,
  openTerminal: vi.fn(),
  setLigaturesEnabled: vi.fn()
}))

import { PaneManager } from './pane-manager'

const FIRST_LEAF_ID = '11111111-1111-4111-8111-111111111111' as TerminalLeafId
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222' as TerminalLeafId

class TestRootElement {
  innerHTML = ''

  querySelectorAll(): HTMLElement[] {
    return []
  }
}

function createTestElement(): HTMLElement {
  return new TestRootElement() as unknown as HTMLElement
}

function createPane(id: number, leafId: TerminalLeafId): ManagedPaneInternal {
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: {} as never,
    container: createTestElement(),
    xtermContainer: createTestElement(),
    linkTooltip: createTestElement(),
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
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

function setManagerPanes(manager: PaneManager, panes: [number, ManagedPaneInternal][]): void {
  ;(manager as unknown as { panes: Map<number, ManagedPaneInternal> }).panes = new Map(panes)
}

describe('PaneManager destroy scroll intent cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('clears keyed scroll intent for every pane on permanent destroy', () => {
    const manager = new PaneManager(createTestElement(), {})
    setManagerPanes(manager, [
      [1, createPane(1, FIRST_LEAF_ID)],
      [2, createPane(2, SECOND_LEAF_ID)]
    ])

    manager.destroy()

    expect(clearTerminalScrollIntentKey).toHaveBeenCalledWith(FIRST_LEAF_ID)
    expect(clearTerminalScrollIntentKey).toHaveBeenCalledWith(SECOND_LEAF_ID)
  })

  it('preserves keyed scroll intent when destroy is followed by a live-tab remount', () => {
    const manager = new PaneManager(createTestElement(), {})
    setManagerPanes(manager, [[1, createPane(1, FIRST_LEAF_ID)]])

    manager.destroy({ preserveTerminalScrollIntent: true })

    expect(disposePane).toHaveBeenCalledTimes(1)
    expect(clearTerminalScrollIntentKey).not.toHaveBeenCalled()
  })
})
