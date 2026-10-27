import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import {
  linkRowSegmentsFromRanges,
  type SiblingLinkUnderliner
} from './terminal-hover-link-sibling-underline'
import type { IBufferRange, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { buildTerminalHttpLogicalLines, hasHardWrappedRows } from './terminal-http-logical-lines'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import { terminalLogicalLinkHasOscLink } from './terminal-osc-link-cells'

export function createWrappedTerminalHttpLinkProvider(
  terminal: Pick<Terminal, 'buffer'>,
  handlers: Pick<ILink, 'activate' | 'hover' | 'leave'>,
  // #33553: when set, hovering one hard-wrapped row also underlines the URL's other
  // rows (xterm only underlines the hovered link's own range).
  siblingUnderliner?: SiblingLinkUnderliner
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      for (const logicalLine of buildTerminalHttpLogicalLines(
        terminal.buffer.active,
        bufferLineNumber
      )) {
        if (!hasHardWrappedRows(logicalLine)) {
          continue
        }
        const links = extractTerminalHttpLinks(logicalLine.text).flatMap((parsed): ILink[] => {
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (
            !range ||
            range.start.y === range.end.y ||
            bufferLineNumber < range.start.y ||
            bufferLineNumber > range.end.y ||
            terminalLogicalLinkHasOscLink(
              terminal.buffer.active,
              logicalLine,
              parsed.startIndex,
              parsed.endIndex
            )
          ) {
            return []
          }
          const rowRange = rangeForParsedLinkOnRow(
            logicalLine,
            parsed.startIndex,
            parsed.endIndex,
            bufferLineNumber
          )
          if (!rowRange) {
            return []
          }
          // Per-row hit ranges stay (padding must not become clickable); the sibling
          // rows only gain the hover underline.
          const siblingRanges: IBufferRange[] =
            siblingUnderliner === undefined
              ? []
              : logicalLine.rows
                  .filter((row) => row.y + 1 !== bufferLineNumber)
                  .flatMap((row) => {
                    const siblingRange = rangeForParsedLinkOnRow(
                      logicalLine,
                      parsed.startIndex,
                      parsed.endIndex,
                      row.y + 1
                    )
                    return siblingRange ? [siblingRange] : []
                  })
          const link = {
            text: parsed.url,
            range: rowRange,
            ...handlers,
            ...(siblingUnderliner !== undefined
              ? {
                  hover: (event: MouseEvent, uri: string) => {
                    siblingUnderliner.underline(linkRowSegmentsFromRanges(siblingRanges))
                    return handlers.hover?.(event, uri)
                  },
                  leave: (event: MouseEvent, uri: string) => {
                    siblingUnderliner.clear()
                    return handlers.leave?.(event, uri)
                  }
                }
              : {}),
            isBufferValid: () =>
              logicalLine.rows.every((row) => {
                const line = terminal.buffer.active.getLine(row.y)
                return (
                  line?.length === row.lineLength &&
                  line.isWrapped === row.isWrapped &&
                  line.translateToString(false) === row.sourceText
                )
              }) &&
              !terminalLogicalLinkHasOscLink(
                terminal.buffer.active,
                logicalLine,
                parsed.startIndex,
                parsed.endIndex
              )
          }
          return [link]
        })
        if (links.length > 0) {
          callback(links)
          return
        }
      }
      callback(undefined)
    }
  }
}
