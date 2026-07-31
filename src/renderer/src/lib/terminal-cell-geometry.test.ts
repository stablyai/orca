import { describe, expect, it } from 'vitest'
import {
  approximateTerminalCellGeometry,
  clientPointToTerminalCell,
  type TerminalCellGeometry
} from './terminal-cell-geometry'

describe('clientPointToTerminalCell', () => {
  const geometry: TerminalCellGeometry = {
    cellWidth: 10,
    cellHeight: 20,
    originLeft: 4,
    originTop: 6
  }
  const containerRect = { left: 100, top: 200 }

  it('maps a point inside the grid origin to cell (0, 0)', () => {
    expect(clientPointToTerminalCell(104, 206, containerRect, geometry, 80, 24)).toEqual({
      col: 0,
      row: 0
    })
  })

  it('accounts for the container origin offset (padding/margin)', () => {
    // 100 + 4 (origin) + 25 (2.5 cells) = 129
    expect(clientPointToTerminalCell(129, 206, containerRect, geometry, 80, 24)).toEqual({
      col: 2,
      row: 0
    })
  })

  it('clamps to the grid bounds instead of returning out-of-range cells', () => {
    expect(clientPointToTerminalCell(0, 0, containerRect, geometry, 80, 24)).toEqual({
      col: 0,
      row: 0
    })
    expect(clientPointToTerminalCell(10000, 10000, containerRect, geometry, 80, 24)).toEqual({
      col: 79,
      row: 23
    })
  })
})

describe('approximateTerminalCellGeometry', () => {
  it('divides the container box evenly across cols/rows with a zero origin', () => {
    const container = { clientWidth: 800, clientHeight: 480 } as HTMLElement
    expect(approximateTerminalCellGeometry(container, 80, 24)).toEqual({
      cellWidth: 10,
      cellHeight: 20,
      originLeft: 0,
      originTop: 0
    })
  })

  it('guards against a zero cols/rows divide-by-zero', () => {
    const container = { clientWidth: 800, clientHeight: 480 } as HTMLElement
    const result = approximateTerminalCellGeometry(container, 0, 0)
    expect(result.cellWidth).toBe(800)
    expect(result.cellHeight).toBe(480)
  })
})
