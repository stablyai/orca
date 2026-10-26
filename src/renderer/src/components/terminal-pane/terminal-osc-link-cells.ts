import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import { isCorruptedOscLinkText } from './terminal-osc-link-routing'
import type { IBufferLine, IBufferRange, ILinkProvider, Terminal } from '@xterm/xterm'
import type { WrappedLogicalLine } from './wrapped-terminal-link-ranges'

type LinkProviderListOwner = {
  _core?: {
    _linkProviderService?: { linkProviders?: ILinkProvider[] }
    linkifier?: { _linkProviderService?: { linkProviders?: ILinkProvider[] } }
  }
}

export function installCorruptedOscLinkFilter(terminal: Terminal): void {
  try {
    const core = (terminal as unknown as LinkProviderListOwner)._core
    const providers =
      core?._linkProviderService?.linkProviders ??
      core?.linkifier?._linkProviderService?.linkProviders
    if (Array.isArray(providers)) {
      for (const provider of providers) {
        if (!provider || typeof provider.provideLinks !== 'function') {
          continue
        }
        const originalProvideLinks = provider.provideLinks.bind(provider)
        provider.provideLinks = (bufferLineNumber, callback) => {
          originalProvideLinks(bufferLineNumber, (links) => {
            callback(links?.filter((link) => !isCorruptedOscLinkText(link.text)))
          })
        }
      }
    }
    terminal.parser?.registerOscHandler?.(8, (data) => isCorruptedOscLinkText(data))
  } catch {
    // Best-effort guard around xterm internals.
  }
}

export function terminalLogicalLinkHasOscLink(
  buffer: { getLine(y: number): IBufferLine | undefined },
  logicalLine: WrappedLogicalLine,
  startIndex: number,
  endIndex: number
): boolean {
  return logicalLine.rows.some((row) => {
    const range = rangeForParsedLinkOnRow(logicalLine, startIndex, endIndex, row.y + 1)
    return range !== null && terminalRangeHasOscLink(buffer, range)
  })
}

function terminalRangeHasOscLink(
  buffer: { getLine(y: number): IBufferLine | undefined },
  range: IBufferRange
): boolean {
  for (let y = range.start.y; y <= range.end.y; y++) {
    const line = buffer.getLine(y - 1)
    if (!line || typeof line.getCell !== 'function') {
      continue
    }
    const start = y === range.start.y ? range.start.x - 1 : 0
    const end = y === range.end.y ? range.end.x : line.length
    for (let x = start; x < end; x++) {
      const cell = line.getCell(x)
      // The public cell API omits hyperlink metadata; check the runtime shape before using it.
      if (
        cell &&
        'hasExtendedAttrs' in cell &&
        typeof cell.hasExtendedAttrs === 'function' &&
        cell.hasExtendedAttrs() &&
        'extended' in cell &&
        typeof cell.extended === 'object' &&
        cell.extended !== null &&
        'urlId' in cell.extended &&
        typeof cell.extended.urlId === 'number' &&
        cell.extended.urlId > 0
      ) {
        return true
      }
    }
  }
  return false
}
