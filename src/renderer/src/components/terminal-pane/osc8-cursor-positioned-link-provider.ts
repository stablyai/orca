import type {
  IBufferCell,
  IBufferLine,
  IBufferRange,
  IDisposable,
  ILink,
  ILinkProvider,
  Terminal
} from '@xterm/xterm'

type OscLinkTerminal = {
  cols: number
  buffer: { active: { length: number; getLine(y: number): IBufferLine | undefined } }
}

type Osc8LinkProviderDeps = {
  getTerminal: () => OscLinkTerminal | null
  /**
   * The URL for a `urlId`. xterm's OSC 8 store is internal, so callers seed
   * this from the `linkHandler` callbacks, which receive the URL and the row it
   * was resolved on.
   */
  getLinkUrl: (urlId: number) => string | undefined
  onActivate: (event: MouseEvent | undefined, url: string, range: IBufferRange) => void
  onHover: (event: MouseEvent | undefined, url: string, range: IBufferRange) => void
  onLeave: () => void
}

// Why: a TUI can paint far more rows than fit on screen; bound the walk so a
// pathological buffer cannot stall the hover path.
const MAX_LINK_ROWS = 200

type CellReader = (x: number) => IBufferCell | undefined

// Why: xterm records OSC 8 membership on a cell's extended attributes, but
// neither the accessor nor `urlId` appears in the published typings.
type ExtendedAttrsCell = IBufferCell & {
  hasExtendedAttrs(): boolean
  extended?: { urlId?: number }
}

export function readOsc8UrlId(cell: IBufferCell | undefined): number | undefined {
  const extendedCell = cell as ExtendedAttrsCell | undefined
  if (!extendedCell?.hasExtendedAttrs?.()) {
    return undefined
  }
  return extendedCell.extended?.urlId || undefined
}

/**
 * Columns up to the last cell holding content.
 *
 * xterm's own line object exposes `getTrimmedLength`, but the public
 * `IBufferLine` does not, so derive it from `getCell` to stay on documented API.
 */
function trimmedLengthOf(line: IBufferLine): number {
  for (let x = line.length - 1; x >= 0; x--) {
    const chars = line.getCell(x)?.getChars()
    if (chars !== undefined && chars !== '') {
      return x + 1
    }
  }
  return 0
}

function cellReaderFor(line: IBufferLine | undefined): CellReader {
  return (x: number) => line?.getCell(x)
}

function rowHasUrlId(line: IBufferLine | undefined, x: number, urlId: number): boolean {
  return readOsc8UrlId(cellReaderFor(line)(x)) === urlId
}

/** First column of the run carrying `urlId` that ends at the row's last cell. */
function trailingRunStart(line: IBufferLine, urlId: number): number | null {
  const end = trimmedLengthOf(line)
  if (end === 0 || !rowHasUrlId(line, end - 1, urlId)) {
    return null
  }
  let start = end - 1
  while (start > 0 && rowHasUrlId(line, start - 1, urlId)) {
    start--
  }
  return start
}

/** Column after the run carrying `urlId` that starts at the row's first cell. */
function leadingRunEnd(line: IBufferLine, urlId: number): number | null {
  const trimmed = trimmedLengthOf(line)
  if (trimmed === 0 || !rowHasUrlId(line, 0, urlId)) {
    return null
  }
  let end = 1
  while (end < trimmed && rowHasUrlId(line, end, urlId)) {
    end++
  }
  return end
}

/**
 * Grows a single row's OSC 8 run across the rows a TUI painted it onto.
 *
 * xterm's own OSC 8 provider only merges rows carrying its `isWrapped` flag,
 * which a TUI that positions its own output never sets — so a link split across
 * rows highlighted only the row under the pointer even though the whole span
 * shares one `urlId`. Walk by `urlId` instead: the emitter already told us
 * which cells belong to one link.
 */
function expandRangeAcrossRows(
  terminal: OscLinkTerminal,
  bufferLineNumber: number,
  startX: number,
  endX: number,
  urlId: number
): IBufferRange {
  const buffer = terminal.buffer.active
  let startY = bufferLineNumber
  let endY = bufferLineNumber
  let start = startX
  let end = endX

  // Why: only a run touching the row edge can continue onto its neighbour; a
  // run ending mid-row ended because the link did.
  for (let steps = 0; start === 0 && steps < MAX_LINK_ROWS; steps++) {
    const previous = buffer.getLine(startY - 2)
    if (!previous) {
      break
    }
    const runStart = trailingRunStart(previous, urlId)
    if (runStart === null) {
      break
    }
    startY--
    start = runStart
  }

  for (let steps = 0; steps < MAX_LINK_ROWS; steps++) {
    const current = buffer.getLine(endY - 1)
    if (!current || end !== trimmedLengthOf(current)) {
      break
    }
    const next = buffer.getLine(endY)
    if (!next) {
      break
    }
    const runEnd = leadingRunEnd(next, urlId)
    if (runEnd === null) {
      break
    }
    endY++
    end = runEnd
  }

  // Why: xterm link ranges are 1-based inclusive; runs are 0-based half-open.
  return { start: { x: start + 1, y: startY }, end: { x: end, y: endY } }
}

/**
 * Gives this provider precedence over xterm's own OSC 8 provider.
 *
 * The linkifier resolves a hover against providers in registration order and
 * takes the first that matches. xterm registers its OSC 8 provider during
 * construction, so anything registered later can never win for the same cells —
 * the narrower single-row range would always be chosen. Moving this provider to
 * the front is the only way to be preferred; it declines every link it does not
 * widen, so the built-in provider still handles the rest.
 */
export function registerFirstLinkProvider(
  terminal: Pick<Terminal, 'registerLinkProvider'>,
  provider: ILinkProvider
): IDisposable {
  const providers = (
    terminal as unknown as {
      _core?: { _linkProviderService?: { linkProviders?: ILinkProvider[] } }
    }
  )._core?._linkProviderService?.linkProviders
  const countBefore = Array.isArray(providers) ? providers.length : -1

  const disposable = terminal.registerLinkProvider(provider)

  // Why: Orca wraps every provider in an error guard before registering it, so
  // the array holds the wrapper rather than `provider`. Take whatever landed at
  // the end instead of searching by identity.
  if (Array.isArray(providers) && providers.length === countBefore + 1) {
    const registered = providers.pop()!
    providers.unshift(registered)
  }
  return disposable
}

/**
 * Reports OSC 8 links that span rows a TUI cursor-positioned rather than
 * soft-wrapped, so hover highlights the whole link instead of one row.
 *
 * Only links wider than a single row are reported; xterm's own provider keeps
 * everything else.
 */
export function createOsc8CursorPositionedLinkProvider(deps: Osc8LinkProviderDeps): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      const line = terminal?.buffer.active.getLine(bufferLineNumber - 1)
      if (!terminal || !line) {
        callback(undefined)
        return
      }

      const links: ILink[] = []
      const trimmed = trimmedLengthOf(line)
      let runStart = -1
      let runUrlId = -1

      const flush = (endExclusive: number): void => {
        if (runStart === -1) {
          return
        }
        const url = deps.getLinkUrl(runUrlId)
        const range = url
          ? expandRangeAcrossRows(terminal, bufferLineNumber, runStart, endExclusive, runUrlId)
          : null
        // Why: a single-row range is already handled correctly by xterm's own
        // provider; reporting it again would only duplicate work.
        if (url && range && range.start.y !== range.end.y) {
          links.push({
            range,
            text: url,
            // Why: xterm defaults these on, but state them so a wrapped link is
            // decorated identically to the single-row links its own provider
            // reports — the whole point is that the two look the same.
            //
            // Underline plus pointer, with no recoloring: xterm draws the
            // underline in the cell's own foreground, so it adapts to any theme.
            // Ghostty settled on the same restraint — a hardcoded single
            // underline coloured `underlineColor(palette) orelse fg`, with no
            // link-specific colour and no config to change it — which is why
            // Orca exposes no link-appearance setting either.
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => deps.onActivate(event, url, range),
            hover: (event) => deps.onHover(event, url, range),
            leave: () => deps.onLeave()
          })
        }
        runStart = -1
        runUrlId = -1
      }

      for (let x = 0; x < trimmed; x++) {
        const urlId = readOsc8UrlId(line.getCell(x))
        if (urlId === undefined) {
          flush(x)
          continue
        }
        if (runStart === -1) {
          runStart = x
          runUrlId = urlId
        } else if (urlId !== runUrlId) {
          flush(x)
          runStart = x
          runUrlId = urlId
        }
      }
      flush(trimmed)

      callback(links.length > 0 ? links : undefined)
    }
  }
}
