/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it, vi } from 'vitest'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'
import type { ManagedPaneInternal } from './pane-manager-types'
import { arrangeMountedPanesAsOrchestrationGrid } from './pane-orchestration-grid'

vi.mock('./pane-split-scroll', () => ({
  clearPendingSplitScrollRestore: vi.fn(),
  scheduleSplitScrollRestore: vi.fn()
}))
vi.mock('./pane-webgl-reattach', () => ({ reattachWebglIfNeeded: vi.fn() }))
vi.mock('./pane-webgl-renderer', () => ({ disposeWebgl: vi.fn() }))
vi.mock('./pane-tree-ops', () => ({
  applyPaneFlexStyle: (element: HTMLElement) => {
    element.style.flex = '1 1 0%'
    element.style.minWidth = '0'
    element.style.minHeight = '0'
    element.style.width = ''
    element.style.height = ''
  },
  captureScrollState: vi.fn(() => ({ kind: 'bottom' })),
  safeFit: vi.fn()
}))

function leafIdForIndex(index: number): TerminalLeafId {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}` as TerminalLeafId
}

function createPane(index: number, leafIndex = index): ManagedPaneInternal {
  const container = document.createElement('div')
  container.className = 'pane'
  container.dataset.paneId = String(index)
  const leafId = leafIdForIndex(leafIndex)
  container.dataset.leafId = leafId
  // Why: this DOM-only test mocks every collaborator that reads the remaining
  // pane internals; Partial keeps the exercised fixture fields type-checked.
  const fixture: Partial<ManagedPaneInternal> = {
    id: index,
    leafId,
    stablePaneId: leafId,
    container,
    terminal: {} as never,
    webglAddon: null,
    pendingSplitScrollState: null
  }
  return fixture as ManagedPaneInternal
}

function paneGeometry(
  element: HTMLElement,
  geometry = { width: 1, height: 1 },
  result = new Map<string, { width: number; height: number }>()
): Map<string, { width: number; height: number }> {
  if (element.classList.contains('pane')) {
    result.set(element.dataset.leafId!, geometry)
    return result
  }
  const children = [...element.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && !child.classList.contains('pane-divider')
  )
  const firstGrow = Number.parseFloat(children[0]?.style.flex ?? '1')
  const secondGrow = Number.parseFloat(children[1]?.style.flex ?? '1')
  const ratio = firstGrow / (firstGrow + secondGrow)
  const vertical = element.classList.contains('is-vertical')
  paneGeometry(
    children[0]!,
    vertical
      ? { width: geometry.width * ratio, height: geometry.height }
      : { width: geometry.width, height: geometry.height * ratio },
    result
  )
  paneGeometry(
    children[1]!,
    vertical
      ? { width: geometry.width * (1 - ratio), height: geometry.height }
      : { width: geometry.width, height: geometry.height * (1 - ratio) },
    result
  )
  return result
}

function panePixelGeometry(
  element: HTMLElement,
  geometry: { x: number; y: number; width: number; height: number },
  result = new Map<string, { x: number; y: number; width: number; height: number }>()
): Map<string, { x: number; y: number; width: number; height: number }> {
  const calculatedWidth =
    element.style.alignSelf === 'flex-start'
      ? element.style.width.match(/^calc\(([\d.]+)% - ([\d.]+)px\)$/)
      : null
  const resolvedGeometry = {
    ...geometry,
    width: calculatedWidth
      ? (geometry.width * Number.parseFloat(calculatedWidth[1]!)) / 100 -
        Number.parseFloat(calculatedWidth[2]!)
      : geometry.width
  }
  if (element.classList.contains('pane')) {
    result.set(element.dataset.leafId!, resolvedGeometry)
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
  const vertical = element.classList.contains('is-vertical')
  const axisSize = vertical ? resolvedGeometry.width : resolvedGeometry.height
  const dividerSize = Number.parseFloat(vertical ? divider.style.width : divider.style.height)
  const flex = content.map((child) => {
    const [grow = '1', , basis = '0'] = child.style.flex.split(/\s+/)
    return { grow: Number.parseFloat(grow), basis: Number.parseFloat(basis) }
  })
  const freeSpace = axisSize - dividerSize - flex[0]!.basis - flex[1]!.basis
  const firstSize = flex[0]!.basis + (freeSpace * flex[0]!.grow) / (flex[0]!.grow + flex[1]!.grow)
  const secondSize = axisSize - dividerSize - firstSize
  panePixelGeometry(
    content[0]!,
    vertical
      ? { ...resolvedGeometry, width: firstSize }
      : { ...resolvedGeometry, height: firstSize },
    result
  )
  panePixelGeometry(
    content[1]!,
    vertical
      ? {
          ...resolvedGeometry,
          x: resolvedGeometry.x + firstSize + dividerSize,
          width: secondSize
        }
      : {
          ...resolvedGeometry,
          y: resolvedGeometry.y + firstSize + dividerSize,
          height: secondSize
        },
    result
  )
  return result
}

describe('arrangeMountedPanesAsOrchestrationGrid', () => {
  it('starts a second equal-height row at pane seven and compacts after removal', () => {
    const root = document.createElement('div')
    const panes = new Map(
      Array.from({ length: 7 }, (_, index) => [index + 1, createPane(index + 1)])
    )
    const originalContainers = [...panes.values()].map((pane) => pane.container)

    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      styleOptions: {},
      isDestroyed: () => false
    })

    expect(root.firstElementChild?.classList.contains('is-horizontal')).toBe(true)
    const sevenPaneGeometry = paneGeometry(root.firstElementChild as HTMLElement)
    for (let index = 1; index <= 6; index += 1) {
      const pane = sevenPaneGeometry.get(panes.get(index)!.leafId)!
      expect(pane.width).toBeCloseTo(1 / 6)
      expect(pane.height).toBeCloseTo(1 / 2)
    }
    expect(originalContainers.every((container) => root.contains(container))).toBe(true)

    panes.delete(2)
    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      styleOptions: {},
      isDestroyed: () => false
    })

    expect(root.firstElementChild?.classList.contains('is-vertical')).toBe(true)
    for (const pane of paneGeometry(root.firstElementChild as HTMLElement).values()) {
      expect(pane.width).toBeCloseTo(1 / 6)
      expect(pane.height).toBe(1)
    }
  })

  it.each([
    { count: 7, cellHeight: 439.5, rowPitch: 448.5 },
    { count: 8, cellHeight: 439.5, rowPitch: 448.5 },
    { count: 13, cellHeight: 290, rowPitch: 299 }
  ])(
    'keeps every cell equal in a $count-pane grid after fixed divider pixels are removed',
    ({ count, cellHeight, rowPitch }) => {
      const root = document.createElement('div')
      const panes = new Map(
        Array.from({ length: count }, (_, index) => [index + 1, createPane(index + 1)])
      )

      arrangeMountedPanesAsOrchestrationGrid({
        root,
        panes,
        styleOptions: { dividerThicknessPx: 3 },
        isDestroyed: () => false
      })

      const geometry = panePixelGeometry(root.firstElementChild as HTMLElement, {
        x: 0,
        y: 0,
        width: 881,
        height: 888
      })
      expect(geometry).toHaveLength(count)
      for (let index = 0; index < count; index += 1) {
        expect(geometry.get(panes.get(index + 1)!.leafId)).toEqual({
          x: expect.closeTo((index % 6) * 148.33333333333334, 6),
          y: expect.closeTo(Math.floor(index / 6) * rowPitch, 6),
          width: expect.closeTo(139.33333333333334, 6),
          height: expect.closeTo(cellHeight, 6)
        })
      }
    }
  )

  it('uses restored visual leaf order instead of pane creation order', () => {
    const root = document.createElement('div')
    const replayCreationOrder = [1, 7, 4, 3, 2, 6, 5]
    const panes = new Map(
      replayCreationOrder.map((leafIndex, index) => [index + 1, createPane(index + 1, leafIndex)])
    )
    const leafIds = Array.from({ length: 7 }, (_, index) => leafIdForIndex(index + 1))

    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      leafIds,
      styleOptions: { dividerThicknessPx: 3 },
      isDestroyed: () => false
    })

    expect(
      [...root.querySelectorAll<HTMLElement>('.pane')].map((pane) => pane.dataset.leafId)
    ).toEqual(leafIds)
  })

  it('keeps restored leaf order when a later close reflows without a hint', () => {
    const root = document.createElement('div')
    const replayCreationOrder = [1, 7, 4, 3, 2, 6, 5]
    const panes = new Map(
      replayCreationOrder.map((leafIndex, index) => [index + 1, createPane(index + 1, leafIndex)])
    )
    const leafIds = Array.from({ length: 7 }, (_, index) => leafIdForIndex(index + 1))

    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      leafIds,
      styleOptions: { dividerThicknessPx: 3 },
      isDestroyed: () => false
    })
    const closed = [...panes.entries()].find(([, pane]) => pane.leafId === leafIds[1])
    expect(closed).toBeDefined()
    panes.delete(closed![0])

    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      styleOptions: { dividerThicknessPx: 3 },
      isDestroyed: () => false
    })

    expect(
      [...root.querySelectorAll<HTMLElement>('.pane')].map((pane) => pane.dataset.leafId)
    ).toEqual(leafIds.filter((leafId) => leafId !== leafIds[1]))
  })

  it('keeps grid cells equal when users drag or double-click a grid divider', () => {
    const root = document.createElement('div')
    const panes = new Map(
      Array.from({ length: 3 }, (_, index) => [index + 1, createPane(index + 1)])
    )
    const onLayoutChanged = vi.fn()

    arrangeMountedPanesAsOrchestrationGrid({
      root,
      panes,
      styleOptions: { dividerThicknessPx: 3 },
      isDestroyed: () => false,
      onLayoutChanged
    })

    expect(onLayoutChanged).toHaveBeenCalledOnce()
    const gridRoot = root.firstElementChild as HTMLElement
    const before = paneGeometry(gridRoot)
    for (const geometry of before.values()) {
      expect(geometry.width).toBeCloseTo(1 / 3)
    }

    const divider = [...gridRoot.children].find(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.classList.contains('pane-divider')
    )!
    const previous = divider.previousElementSibling as HTMLElement
    const next = divider.nextElementSibling as HTMLElement
    Object.defineProperty(previous, 'getBoundingClientRect', {
      value: () => ({ width: 600, height: 400 })
    })
    Object.defineProperty(next, 'getBoundingClientRect', {
      value: () => ({ width: 300, height: 400 })
    })
    let capturedPointerId: number | null = null
    const setPointerCapture = vi.fn((pointerId: number) => {
      capturedPointerId = pointerId
    })
    Object.defineProperties(divider, {
      setPointerCapture: {
        value: setPointerCapture
      },
      hasPointerCapture: {
        value: vi.fn((pointerId: number) => capturedPointerId === pointerId)
      },
      releasePointerCapture: {
        value: vi.fn(() => {
          capturedPointerId = null
        })
      }
    })
    const pointerDown = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.assign(pointerDown, { pointerId: 7, clientX: 600, clientY: 0 })
    divider.dispatchEvent(pointerDown)
    const pointerCancel = new Event('pointercancel', { bubbles: true })
    Object.assign(pointerCancel, { pointerId: 7, clientX: 600, clientY: 0 })
    window.dispatchEvent(pointerCancel)
    divider.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))

    expect(pointerDown.defaultPrevented).toBe(false)
    expect(setPointerCapture).not.toHaveBeenCalled()
    expect(onLayoutChanged).toHaveBeenCalledOnce()
    for (const geometry of paneGeometry(gridRoot).values()) {
      expect(geometry.width).toBeCloseTo(1 / 3)
    }
  })
})
