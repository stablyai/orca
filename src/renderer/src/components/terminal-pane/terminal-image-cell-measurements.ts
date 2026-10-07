import type { IDisposable, Terminal } from '@xterm/xterm'
import { readTerminalImageCellSize } from '../../../../shared/terminal-image-cell-size'

type TerminalImageMeasurementSource = Pick<Terminal, 'dimensions' | 'onDimensionsChange'>

export function readTerminalImageCellMeasurements(
  terminal: Pick<Terminal, 'dimensions'>
): { cellW: number; cellH: number } | undefined {
  const size = readTerminalImageCellSize(terminal.dimensions?.css.cell)
  return size ? { cellW: size.width, cellH: size.height } : undefined
}

/** A font or renderer change can alter image cells without changing the PTY grid. */
export function observeTerminalImageCellMeasurements(
  terminal: TerminalImageMeasurementSource,
  onChanged: () => boolean | void
): IDisposable & { reassert: () => void } {
  let previous = readTerminalImageCellMeasurements(terminal)
  let disposed = false
  const reassert = (): void => {
    if (disposed) {
      return
    }
    const measured = readTerminalImageCellMeasurements(terminal)
    if (!measured || (measured.cellW === previous?.cellW && measured.cellH === previous.cellH)) {
      return
    }
    if (onChanged() !== false) {
      previous = measured
    }
  }
  const subscription = terminal.onDimensionsChange(reassert)
  return {
    reassert,
    dispose: () => {
      disposed = true
      subscription.dispose()
    }
  }
}
