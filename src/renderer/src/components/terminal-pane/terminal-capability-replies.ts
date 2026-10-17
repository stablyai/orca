import { registerTerminalDa1Owner } from '../../lib/pane-manager/terminal-da1-ownership'
import type { IDisposable, IParser, Terminal } from '@xterm/xterm'
import {
  sendTerminalOscColorQueryReplies as sendTerminalOscColorQueryRepliesForColors,
  terminalOscColorQueryReplies,
  terminalOscColorQuerySlotsForBody,
  type TerminalOscColorQuerySlot
} from '../../../../shared/terminal-osc-color-reply'
import { readTerminalMouseEncoding } from '../../../../shared/terminal-mouse-encoding'
import { guardParserHandler } from './terminal-parser-handler-guard'
import { parseSgrMouseReport } from './terminal-pointer-input-sequences'

export const DEFAULT_DA1_RESPONSE = '\x1b[?1;2c'
export const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

// DEC DA1 "Sixel graphics" capability code; image tools feature-detect on it.
const SIXEL_DA1_ATTRIBUTE = '4'

type CellSize = { width: number; height: number }

// Why: apps convert pixel reports with the last size they were told until they ask again.
const reportedCellSizeByTerminal = new WeakMap<
  Pick<Terminal, 'cols' | 'rows' | 'element'>,
  CellSize
>()

type TerminalCapabilityRepliesDeps = {
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element' | 'options'>
  parser: Pick<IParser, 'registerCsiHandler' | 'registerOscHandler'>
  sendInput: (data: string) => boolean | void
  isReplaying: () => boolean
  da1Response?: string
  // Resolved per query so a live inline-images toggle changes what the next DA1 advertises.
  sixelSupported?: () => boolean
  /** Why a thunk, like sixelSupported: the pane's launch agent may not be registered
   *  in the store yet when the handlers are installed, so a boolean captured here
   *  answers jcode's burst anyway. Why skip at all: jcode themes itself, and the reply
   *  can land before its composer is ready and render as pre-typed text. */
  skipOscColorQueryReplies?: () => boolean
}

// Adds Sixel to a DA1 response so DA1-detecting image tools emit Sixel; idempotent.
export function withSixelDa1Attribute(response: string): string {
  const prefix = '\x1b[?'
  if (!response.startsWith(prefix) || !response.endsWith('c')) {
    return response
  }
  const params = response.slice(prefix.length, -1).split(';').filter(Boolean)
  if (params.length === 0 || !params.every((param) => /^\d+$/.test(param))) {
    return response
  }
  if (params.includes(SIXEL_DA1_ATTRIBUTE)) {
    return response
  }
  return `${prefix}${[...params, SIXEL_DA1_ATTRIBUTE].join(';')}c`
}

function isPrimaryDeviceAttributesQuery(params: (number | number[])[]): boolean {
  return params.length === 0 || (params.length === 1 && params[0] === 0)
}

function getTerminalScreenElement(
  terminal: Pick<Terminal, 'element'>
): Pick<HTMLElement, 'getBoundingClientRect'> | null {
  if (typeof terminal.element?.querySelector !== 'function') {
    return null
  }
  return terminal.element.querySelector('.xterm-screen') ?? null
}

function measureCssCellSize(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>
): CellSize | null {
  if (terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }
  const rect = getTerminalScreenElement(terminal)?.getBoundingClientRect()
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    return null
  }
  return { width: rect.width / terminal.cols, height: rect.height / terminal.rows }
}

function toCellPixels(cell: CellSize): CellSize {
  return {
    width: Math.max(1, Math.round(cell.width)),
    height: Math.max(1, Math.round(cell.height))
  }
}

function measureCellPixels(terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>): CellSize | null {
  const cell = measureCssCellSize(terminal)
  return cell ? toCellPixels(cell) : null
}

// Keeps the cell the pixel falls in and scales only its offset inside that cell.
function toReportedCellPixel(
  pixel: number,
  cssCell: number,
  reportedCell: number,
  cells: number
): number {
  const cell = Math.min(cells - 1, Math.floor(pixel / cssCell))
  // Why multiply first: dividing first rounds 15 / 22 * 22 down to 14, moving whole-px cells.
  const offset = Math.floor(((pixel - cell * cssCell) * reportedCell) / cssCell)
  return cell * reportedCell + Math.min(reportedCell - 1, Math.max(0, offset))
}

/** Rescales an SGR-Pixels (1016) mouse report onto the whole-px cell size given to CSI 14t/16t. */
export function rescalePixelMouseReport(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>,
  data: string
): string {
  // Why: xterm reports unrounded CSS px but 14t/16t can only answer whole px, so clicks drift.
  const report = parseSgrMouseReport(data)
  if (!report || readTerminalMouseEncoding(terminal) !== 'sgr-pixels') {
    return data
  }
  const css = measureCssCellSize(terminal)
  if (!css) {
    return data
  }
  // Why the fallback: a remounted xterm's app was answered by the one it replaced, at this size.
  const reported = reportedCellSizeByTerminal.get(terminal) ?? toCellPixels(css)
  const x = toReportedCellPixel(report.x, css.width, reported.width, terminal.cols)
  const y = toReportedCellPixel(report.y, css.height, reported.height, terminal.rows)
  return `\x1b[<${report.button};${x};${y}${report.final}`
}

function disposeAll(disposables: IDisposable[]): void {
  for (const disposable of disposables) {
    disposable.dispose()
  }
}

export function sendTerminalOscColorQueryReplies(
  data: string,
  terminal: Pick<Terminal, 'options'>,
  sendInput: (data: string) => boolean | void
): boolean {
  return sendTerminalOscColorQueryRepliesForColors(data, terminal.options.theme ?? {}, sendInput)
}

function sendTerminalOscColorQueryRepliesForSlots(
  slots: readonly TerminalOscColorQuerySlot[],
  terminal: Pick<Terminal, 'options'>,
  sendInput: (data: string) => boolean | void
): boolean {
  const replies = terminalOscColorQueryReplies(terminal.options.theme ?? {}, slots)
  if (!replies) {
    return false
  }
  for (const reply of replies) {
    sendInput(reply)
  }
  return true
}

export function createTerminalPixelSizeQueryResponder(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>,
  sendInput: (data: string) => boolean | void
): (data: string) => void {
  let pending = ''
  const respond = (reportsWindowPixels: boolean): void => {
    const cell = measureCellPixels(terminal)
    if (!cell) {
      return
    }
    const width = cell.width * (reportsWindowPixels ? terminal.cols : 1)
    const height = cell.height * (reportsWindowPixels ? terminal.rows : 1)
    if (sendInput(`\x1b[${reportsWindowPixels ? 4 : 6};${height};${width}t`) !== false) {
      reportedCellSizeByTerminal.set(terminal, cell)
    }
  }
  return (data) => {
    const input = pending + data
    pending = input.endsWith('\x1b') || input.endsWith('\x1b[') ? input.slice(-2) : ''
    let offset = 0
    while (offset < input.length) {
      const queryIndex = input.indexOf('\x1b[', offset)
      if (queryIndex === -1) {
        break
      }
      const query = input.slice(queryIndex, queryIndex + 5)
      if (query === '\x1b[14t') {
        respond(true)
        offset = queryIndex + 5
        continue
      }
      if (query === '\x1b[16t') {
        respond(false)
        offset = queryIndex + 5
        continue
      }
      offset = queryIndex + 2
    }
  }
}

export function installTerminalCapabilityReplyHandlers(
  deps: TerminalCapabilityRepliesDeps
): IDisposable {
  const disposables = [
    registerTerminalDa1Owner(deps.terminal, () =>
      deps.parser.registerCsiHandler(
        { final: 'c' },
        guardParserHandler('csi-da1', (params) => {
          if (!isPrimaryDeviceAttributesQuery(params)) {
            return false
          }
          // Why: restored scrollback may contain old DA1 queries; answering those
          // into the fresh shell recreates the stray-input leak this handler fixes.
          if (!deps.isReplaying()) {
            const base = deps.da1Response ?? DEFAULT_DA1_RESPONSE
            deps.sendInput(deps.sixelSupported?.() ? withSixelDa1Attribute(base) : base)
          }
          return true
        })
      )
    ),
    deps.parser.registerOscHandler(
      10,
      guardParserHandler('osc-10-color-query', (data) => {
        const slots = terminalOscColorQuerySlotsForBody(10, data.trim())
        if (!slots) {
          return false
        }
        if (deps.isReplaying() || deps.skipOscColorQueryReplies?.() === true) {
          return true
        }
        return sendTerminalOscColorQueryRepliesForSlots(slots, deps.terminal, deps.sendInput)
      })
    ),
    deps.parser.registerOscHandler(
      11,
      guardParserHandler('osc-11-color-query', (data) => {
        const slots = terminalOscColorQuerySlotsForBody(11, data.trim())
        if (!slots) {
          return false
        }
        if (deps.isReplaying() || deps.skipOscColorQueryReplies?.() === true) {
          return true
        }
        return sendTerminalOscColorQueryRepliesForSlots(slots, deps.terminal, deps.sendInput)
      })
    )
  ]

  return {
    dispose: () => disposeAll(disposables)
  }
}
