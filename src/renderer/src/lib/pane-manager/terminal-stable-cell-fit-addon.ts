import { FitAddon, type ITerminalDimensions } from '@xterm/addon-fit'
import type { Terminal } from '@xterm/xterm'
import { terminalGridSizeForBox } from './terminal-grid-size-for-box'

type CellSizeSource = Pick<Terminal, 'dimensions' | 'element'>

/** Use cell size independent of current columns: xterm’s rounded canvas-width/cols ratio shifts with the source grid, proposing 51 from 75 cols but 52 from 52 in the same box. */
export function readTerminalStableCellSize(
  terminal: CellSizeSource
): { width: number; height: number } | null {
  const dimensions = terminal.dimensions
  if (!dimensions) {
    return null
  }
  const dpr = terminal.element?.ownerDocument.defaultView?.devicePixelRatio || 1
  const width = dimensions.device.cell.width / dpr
  const height = dimensions.device.cell.height / dpr
  if (width > 0 && height > 0) {
    return { width, height }
  }
  const css = dimensions.css.cell
  return css.width > 0 && css.height > 0 ? { width: css.width, height: css.height } : null
}

/** FitAddon whose proposal (and so fit()) is a function of the box, not of the grid it fits from. */
export class StableCellFitAddon extends FitAddon {
  private stableCellTerminal: Terminal | null = null

  public override activate(terminal: Terminal): void {
    this.stableCellTerminal = terminal
    super.activate(terminal)
  }

  public override proposeDimensions(): ITerminalDimensions | undefined {
    const terminal = this.stableCellTerminal
    const parent = terminal?.element?.parentElement
    if (!terminal?.element || !parent) {
      return undefined
    }
    const cell = readTerminalStableCellSize(terminal)
    if (!cell) {
      return undefined
    }
    const view = terminal.element.ownerDocument.defaultView
    if (!view) {
      return super.proposeDimensions()
    }
    const parentStyle = view.getComputedStyle(parent)
    const style = view.getComputedStyle(terminal.element)
    return terminalGridSizeForBox(
      {
        width: Number.parseInt(parentStyle.getPropertyValue('width'), 10) || 0,
        height: Number.parseInt(parentStyle.getPropertyValue('height'), 10) || 0
      },
      {
        cell,
        padding: {
          top: Number.parseInt(style.getPropertyValue('padding-top'), 10) || 0,
          right: Number.parseInt(style.getPropertyValue('padding-right'), 10) || 0,
          bottom: Number.parseInt(style.getPropertyValue('padding-bottom'), 10) || 0,
          left: Number.parseInt(style.getPropertyValue('padding-left'), 10) || 0
        },
        scrollback: terminal.options.scrollback,
        scrollbar: terminal.options.scrollbar
      }
    )
  }
}
