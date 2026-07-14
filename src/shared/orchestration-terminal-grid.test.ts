import { describe, expect, it } from 'vitest'
import type { TerminalPaneLayoutNode } from './types'
import {
  addOrchestrationTerminalGridLeaf,
  buildOrchestrationTerminalGridRoot,
  collectTerminalLayoutLeafIds,
  getOrchestrationTerminalGridColumnCount,
  getOrchestrationGridAppendSourceLeafIds,
  reflowOrchestrationTerminalGrid
} from './orchestration-terminal-grid'

type PaneGeometry = { x: number; y: number; width: number; height: number }

function measure(
  node: TerminalPaneLayoutNode,
  geometry: PaneGeometry,
  panes = new Map<string, PaneGeometry>()
): Map<string, PaneGeometry> {
  if (node.type === 'leaf') {
    panes.set(node.leafId, geometry)
    return panes
  }
  const ratio = node.ratio ?? 0.5
  if (node.direction === 'vertical') {
    measure(node.first, { ...geometry, width: geometry.width * ratio }, panes)
    measure(
      node.second,
      {
        ...geometry,
        x: geometry.x + geometry.width * ratio,
        width: geometry.width * (1 - ratio)
      },
      panes
    )
  } else {
    measure(node.first, { ...geometry, height: geometry.height * ratio }, panes)
    measure(
      node.second,
      {
        ...geometry,
        y: geometry.y + geometry.height * ratio,
        height: geometry.height * (1 - ratio)
      },
      panes
    )
  }
  return panes
}

describe('orchestration terminal grid', () => {
  it.each([1, 2, 3, 6, 7, 8, 12, 13])(
    'builds %i workers into stable canonical rows with at most six leaves',
    (count) => {
      const leafIds = Array.from({ length: count }, (_, index) => `leaf-${index + 1}`)
      const root = buildOrchestrationTerminalGridRoot(leafIds)
      expect(root).not.toBeNull()
      expect(collectTerminalLayoutLeafIds(root)).toEqual(leafIds)
      expect(getOrchestrationGridAppendSourceLeafIds(root)).toEqual(
        leafIds.slice(Math.floor((count - 1) / 6) * 6)
      )
      const geometry = measure(root!, { x: 0, y: 0, width: 1, height: 1 })
      const rowCount = Math.ceil(count / 6)
      for (let index = 0; index < count; index += 1) {
        const row = Math.floor(index / 6)
        const columnsInRow = Math.min(6, count - row * 6)
        expect(geometry.get(leafIds[index]!)?.width).toBeCloseTo(1 / columnsInRow)
        expect(geometry.get(leafIds[index]!)?.height).toBeCloseTo(1 / rowCount)
      }
    }
  )

  it.each([
    [1, 1],
    [6, 6],
    [7, 6],
    [8, 6],
    [13, 6]
  ])('uses %i mounted panes to select %i physical grid columns', (count, expectedColumns) => {
    expect(getOrchestrationTerminalGridColumnCount(count)).toBe(expectedColumns)
  })

  it('reflows remaining workers and filters leaf-keyed state after a close', () => {
    let layout = addOrchestrationTerminalGridLeaf(null, {
      leafId: 'leaf-1',
      ptyId: 'pty-1'
    })
    for (let index = 2; index <= 7; index += 1) {
      layout = addOrchestrationTerminalGridLeaf(layout, {
        leafId: `leaf-${index}`,
        ptyId: `pty-${index}`
      })
    }
    const survivors = collectTerminalLayoutLeafIds(layout.root).filter(
      (leafId) => leafId !== 'leaf-2'
    )
    const reflowed = reflowOrchestrationTerminalGrid(layout, survivors)
    expect(collectTerminalLayoutLeafIds(reflowed.root)).toEqual([
      'leaf-1',
      'leaf-3',
      'leaf-4',
      'leaf-5',
      'leaf-6',
      'leaf-7'
    ])
    expect(reflowed.ptyIdsByLeafId).not.toHaveProperty('leaf-2')
    const geometry = measure(reflowed.root!, { x: 0, y: 0, width: 1, height: 1 })
    for (const pane of geometry.values()) {
      expect(pane.width).toBeCloseTo(1 / 6)
      expect(pane.height).toBe(1)
    }
  })
})
