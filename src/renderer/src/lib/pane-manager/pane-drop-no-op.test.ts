/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  createDragReorderState,
  handlePaneDrop,
  type DragReorderCallbacks
} from './pane-drag-reorder'

import type { TerminalLeafId } from '../../../../shared/workspace-layout/stable-pane-id'
import { serializePaneTree } from '@/components/terminal-pane/layout-serialization'
import {
  insertLeafBeside,
  removeLayoutLeaf
} from '../../../../shared/workspace-layout/terminal-pane-tree'

function makeLeafId(id: number): TerminalLeafId {
  return `${id}${id}${id}${id}${id}${id}${id}${id}-${id}${id}${id}${id}-4${id}${id}${id}-8${id}${id}${id}-${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}` as TerminalLeafId
}

function createPane(id: number, container: HTMLElement): ManagedPaneInternal {
  const leafId = makeLeafId(id)
  container.classList.add('pane')
  container.dataset.paneId = String(id)
  container.dataset.leafId = leafId
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: {} as never,
    container,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    imageAddon: null,
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

function createVerticalSplit(paneIds: readonly number[]): Map<number, ManagedPaneInternal> {
  const split = document.createElement('div')
  split.className = 'pane-split is-vertical'
  document.body.appendChild(split)

  const panes = new Map<number, ManagedPaneInternal>()
  for (const id of paneIds) {
    const container = document.createElement('div')
    split.appendChild(container)
    panes.set(id, createPane(id, container))
  }
  return panes
}

describe('handlePaneDrop with a drop taker', () => {
  function callbacksFor(panes: Map<number, ManagedPaneInternal>) {
    const root = panes.get(1)!.container.parentElement!
    const callbacks: DragReorderCallbacks = {
      getPanes: () => panes,
      getRoot: () => root,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn()
    }
    return { callbacks }
  }

  it('draws the same tree main saves for a move out of a nested, resized split', () => {
    const panes = createVerticalSplit([1, 2])
    const outer = panes.get(1)!.container.parentElement!
    panes.get(1)!.container.style.flex = '7 1 0%'
    const inner = document.createElement('div')
    inner.className = 'pane-split is-horizontal'
    inner.style.flex = '3 1 0%'
    outer.replaceChild(inner, panes.get(2)!.container)
    inner.appendChild(panes.get(2)!.container)
    const third = document.createElement('div')
    inner.appendChild(third)
    panes.set(3, createPane(3, third))
    const before = serializePaneTree(outer)!
    const { callbacks } = callbacksFor(panes)
    // The manager's root holds the top split; it is not the split itself.
    const root = document.createElement('div')
    outer.replaceWith(root)
    root.appendChild(outer)
    callbacks.getRoot = () => root

    handlePaneDrop(3, 1, 'left', createDragReorderState(), callbacks)

    const saved = insertLeafBeside(
      removeLayoutLeaf(before, makeLeafId(3))!,
      makeLeafId(1),
      makeLeafId(3),
      'left'
    )
    expect(serializePaneTree(outer)).toEqual(saved)
    expect(saved).toMatchObject({ ratio: 0.7 })
  })
})
