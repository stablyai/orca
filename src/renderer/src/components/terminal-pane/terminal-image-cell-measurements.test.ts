import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  observeTerminalImageCellMeasurements,
  readTerminalImageCellMeasurements
} from './terminal-image-cell-measurements'
import { readTerminalImageCellSize } from '../../../../shared/terminal-image-cell-size'

describe('terminal image cell measurements', () => {
  it('does not fabricate a cell size before the renderer opens', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    try {
      expect(readTerminalImageCellMeasurements(terminal)).toBeUndefined()
    } finally {
      terminal.dispose()
    }
  })

  it('uses exact CSS cells rather than device pixels or rounded dimensions', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    vi.spyOn(terminal, 'dimensions', 'get').mockReturnValue({
      css: { cell: { width: 9.025, height: 18 }, canvas: { width: 722, height: 432 } },
      device: {
        cell: { width: 18, height: 36 },
        canvas: { width: 1440, height: 864 },
        char: { width: 18, height: 36, left: 0, top: 0 }
      }
    })
    try {
      expect(readTerminalImageCellMeasurements(terminal)).toEqual({ cellW: 9.025, cellH: 18 })
    } finally {
      terminal.dispose()
    }
  })

  it('observes same-grid font changes, deduplicates cells and releases its subscription', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    const dispose = vi.fn()
    let dimensionsChanged = (): void => {}
    const subscribe: Terminal['onDimensionsChange'] = (listener) => {
      dimensionsChanged = () => {
        const current = terminal.dimensions
        if (!current) {
          throw new Error('Expected render dimensions')
        }
        listener(current)
      }
      return { dispose }
    }
    Object.defineProperty(terminal, 'onDimensionsChange', { value: subscribe })
    const dimensions = {
      css: { cell: { width: 9.025, height: 18 }, canvas: { width: 722, height: 432 } },
      device: {
        cell: { width: 18, height: 36 },
        canvas: { width: 1440, height: 864 },
        char: { width: 18, height: 36, left: 0, top: 0 }
      }
    }
    vi.spyOn(terminal, 'dimensions', 'get').mockImplementation(() => dimensions)
    const changed = vi.fn()
    const subscription = observeTerminalImageCellMeasurements(terminal, changed)
    try {
      dimensionsChanged()
      expect(changed).not.toHaveBeenCalled()
      dimensions.css.cell.width = 10.5
      dimensionsChanged()
      dimensionsChanged()
      expect(changed).toHaveBeenCalledOnce()
      expect(terminal.cols).toBe(80)
      dimensions.css.cell.height = 0
      dimensionsChanged()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      subscription.dispose()
      terminal.dispose()
      expect(dispose).toHaveBeenCalledOnce()
    }
  })

  it.each([
    null,
    {},
    { width: 0, height: 18 },
    { width: Number.NaN, height: 18 },
    { width: Infinity, height: 18 },
    { width: 9, height: -1 },
    { width: '9', height: 18 }
  ])('rejects unusable measurements %j', (value) =>
    expect(readTerminalImageCellSize(value)).toBeNull()
  )

  it('keeps a hidden or parked font change pending until an authoritative viewer accepts it', () => {
    const terminal = new Terminal({ allowProposedApi: true })
    let dimensionsChanged = (): void => {}
    const subscribe: Terminal['onDimensionsChange'] = (listener) => {
      dimensionsChanged = () => {
        const current = terminal.dimensions
        if (!current) {
          throw new Error('Expected render dimensions')
        }
        listener(current)
      }
      return { dispose: vi.fn() }
    }
    Object.defineProperty(terminal, 'onDimensionsChange', { value: subscribe })
    const dimensions = {
      css: { cell: { width: 9.025, height: 18 }, canvas: { width: 722, height: 432 } },
      device: {
        cell: { width: 18, height: 36 },
        canvas: { width: 1440, height: 864 },
        char: { width: 18, height: 36, left: 0, top: 0 }
      }
    }
    vi.spyOn(terminal, 'dimensions', 'get').mockImplementation(() => dimensions)
    const changed = vi.fn(() => false)
    const subscription = observeTerminalImageCellMeasurements(terminal, changed)
    try {
      dimensions.css.cell.width = 10.5
      dimensionsChanged()
      changed.mockReturnValue(true)
      subscription.reassert()
      expect(changed).toHaveBeenCalledTimes(2)
      subscription.reassert()
      expect(changed).toHaveBeenCalledTimes(2)
    } finally {
      subscription.dispose()
      terminal.dispose()
    }
  })
})
