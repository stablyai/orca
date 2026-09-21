import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

const disposePane = vi.hoisted(() =>
  vi.fn((pane: ManagedPaneInternal, panes: Map<number, ManagedPaneInternal>) => {
    panes.delete(pane.id)
  })
)

vi.mock('./pane-tree-ops', () => ({
  captureScrollState: vi.fn(),
  findPaneChildren: vi.fn(() => []),
  promoteSibling: vi.fn(),
  removeDividers: vi.fn(),
  safeFit: vi.fn(),
  wrapInSplit: vi.fn()
}))
vi.mock('./pane-lifecycle', () => ({ disposePane, openTerminal: vi.fn() }))
vi.mock('./pane-webgl-renderer', () => ({ disposeWebgl: vi.fn() }))
vi.mock('./pane-split-scroll', () => ({
  clearPendingSplitScrollRestore: vi.fn(),
  scheduleSplitScrollRestore: vi.fn()
}))
vi.mock('./pane-drag-reorder', () => ({ updateMultiPaneState: vi.fn() }))
vi.mock('./pane-divider', () => ({ applyDividerStyles: vi.fn(), applyPaneOpacity: vi.fn() }))

import {
  closeManagedPane,
  detachManagedPaneForExternalMove,
  retireManagedPanePreservingPty
} from './pane-split-close'
import {
  bindTerminalScrollIntentKey,
  markTerminalPinnedViewport,
  type TerminalScrollIntentTarget
} from './terminal-scroll-intent'
import {
  readTerminalScrollIntentKeyRetention,
  releaseTerminalScrollIntentKey
} from './terminal-scroll-intent-key-store'

function leafIdAt(index: number): TerminalLeafId {
  return `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` as TerminalLeafId
}

/** A pinned (non-bottom) viewport so a keyed intent is actually retained. */
function createPinnedTerminal(): TerminalScrollIntentTarget {
  return {
    buffer: { active: { type: 'normal', viewportY: 3, baseY: 40 } } as never,
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn()
  }
}

function createPane(id: number, leafId: TerminalLeafId): ManagedPaneInternal {
  const container = {
    classList: { contains: (className: string) => className === 'pane' },
    dataset: { paneId: String(id), leafId },
    parentElement: null,
    remove: vi.fn()
  }
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: { focus: vi.fn() } as never,
    container: container as unknown as HTMLElement,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: false,
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

function openPane(id: number, leafId: TerminalLeafId): ManagedPaneInternal {
  const pane = createPane(id, leafId)
  const terminal = createPinnedTerminal()
  bindTerminalScrollIntentKey(terminal, leafId)
  markTerminalPinnedViewport(terminal)
  return pane
}

function closeArgs(pane: ManagedPaneInternal, panes: Map<number, ManagedPaneInternal>) {
  return {
    paneId: pane.id,
    activePaneId: null,
    panes,
    root: {} as HTMLElement,
    styleOptions: {},
    managerOptions: { linkOpenHint: () => '' },
    getDragCallbacks: () => ({}) as never,
    releasePaneIdentity: vi.fn(),
    setActivePaneId: vi.fn()
  }
}

describe('terminal scroll intent key retention', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns both keyed maps to baseline after 200 pane open/close cycles', () => {
    const baseline = readTerminalScrollIntentKeyRetention()

    for (let index = 0; index < 200; index += 1) {
      const leafId = leafIdAt(index)
      const pane = openPane(index + 1, leafId)
      const panes = new Map([[pane.id, pane]])
      // A pinned pane must actually retain its keyed intent while it is open.
      expect(readTerminalScrollIntentKeyRetention()).toEqual({
        intents: baseline.intents + 1,
        bindings: baseline.bindings + 1
      })
      // Keep a second pane so close is never the last-pane no-op path.
      const survivor = createPane(10_000 + index, leafIdAt(10_000 + index))
      panes.set(survivor.id, survivor)
      closeManagedPane(closeArgs(pane, panes))
    }

    expect(readTerminalScrollIntentKeyRetention()).toEqual(baseline)
  })

  it('keeps the keyed intent when the leaf is handed to a new host', () => {
    const baseline = readTerminalScrollIntentKeyRetention()

    for (const teardown of [detachManagedPaneForExternalMove, retireManagedPanePreservingPty]) {
      const leafId = leafIdAt(9000 + Number(teardown === retireManagedPanePreservingPty))
      const pane = openPane(9000, leafId)
      const survivor = createPane(9001, leafIdAt(9001))
      const panes = new Map([
        [pane.id, pane],
        [survivor.id, survivor]
      ])

      expect(teardown(closeArgs(pane, panes))).toBe(true)
      expect(readTerminalScrollIntentKeyRetention().intents).toBe(baseline.intents + 1)

      releaseTerminalScrollIntentKey(leafId)
    }

    expect(readTerminalScrollIntentKeyRetention()).toEqual(baseline)
  })
})
