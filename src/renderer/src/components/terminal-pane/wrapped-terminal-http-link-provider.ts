import { rangeForParsedLinkOnRow } from './terminal-link-row-range'
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { buildTerminalHttpLogicalLines, hasHardWrappedRows } from './terminal-http-logical-lines'
import { extractTerminalHttpLinks } from './terminal-http-url-extraction'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import { terminalLogicalLinkHasOscLink } from './terminal-osc-link-cells'

export function createWrappedTerminalHttpLinkProvider(
  terminal: Pick<Terminal, 'buffer'>,
  handlers: Pick<ILink, 'activate' | 'hover' | 'leave'>
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
          const link = {
            text: parsed.url,
            range: rowRange,
            ...handlers,
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
