/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { isPaneDropNoOp } from './pane-drag-reorder'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

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

describe('isPaneDropNoOp', () => {
  it('treats dropping an already-right sibling onto the left pane as a no-op', () => {
    const panes = createVerticalSplit([1, 2])
    expect(isPaneDropNoOp(2, 1, 'right', panes)).toBe(true)
  })

  it('treats dropping an already-left sibling onto the right pane as a no-op', () => {
    const panes = createVerticalSplit([1, 2])
    expect(isPaneDropNoOp(1, 2, 'left', panes)).toBe(true)
  })

  it('allows reordering when a third pane sits between source and target', () => {
    const panes = createVerticalSplit([1, 2, 3])
    expect(isPaneDropNoOp(3, 1, 'right', panes)).toBe(false)
  })

  it('allows swapping adjacent vertical panes via the opposite edge', () => {
    const panes = createVerticalSplit([1, 2])
    expect(isPaneDropNoOp(2, 1, 'left', panes)).toBe(false)
    expect(isPaneDropNoOp(1, 2, 'right', panes)).toBe(false)
  })
})
