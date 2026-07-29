import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { buildBlockWrappedHttpLogicalLineCandidates } from './block-wrapped-terminal-http-links'
import { extractTerminalHttpLinks } from './terminal-http-url-token-scanning'
import { isTerminalHttpLinkActivation } from './terminal-http-link-activation'
import {
  openTerminalHttpLink,
  type TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import { rangeForParsedFileLink } from './wrapped-terminal-link-ranges'

type BlockWrappedHttpLinkProviderDeps = {
  getTerminal: () => Terminal | null
  worktreeId: string
  linkTooltip: HTMLElement
  openLinkHint: string
  formatTooltip?: (url: string, openLinkHint: string) => Promise<string | null> | string | null
  requestOpenLinksInAppPreference?: TerminalLinkRoutingPreferenceRequester
}

/**
 * Surfaces block-width-wrapped URLs to xterm's linkifier.
 *
 * WebLinksAddon walks rows through xterm's `isWrapped` metadata, which a TUI
 * that positions its own output never sets. It therefore reports the URL on the
 * row bearing the scheme and nothing at all on the continuation rows — so
 * hovering the tail showed no tooltip even though a modifier-click there opened
 * the link via the mouseup fallback. This provider spans every constituent row,
 * keeping hover and click on the same target.
 */
export function createBlockWrappedHttpLinkProvider(
  deps: BlockWrappedHttpLinkProviderDeps
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      if (!terminal) {
        callback(undefined)
        return
      }

      const logicalLines = buildBlockWrappedHttpLogicalLineCandidates(
        terminal.buffer.active,
        bufferLineNumber
      )
      let hoverToken = 0
      for (const logicalLine of logicalLines) {
        for (const parsed of extractTerminalHttpLinks(logicalLine.text)) {
          // Why: only the URL that actually spans the wrap belongs here; a
          // complete URL sharing the start row is WebLinksAddon's to report.
          if (parsed.endIndex < logicalLine.rows[0].text.length) {
            continue
          }
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (!range) {
            continue
          }

          const link: ILink = {
            range,
            text: parsed.url,
            activate: (event) => {
              if (!isTerminalHttpLinkActivation(event)) {
                return
              }
              event.preventDefault()
              openTerminalHttpLink(parsed.url, {
                worktreeId: deps.worktreeId,
                forceSystemBrowser: event.shiftKey,
                requestOpenLinksInAppPreference: deps.requestOpenLinksInAppPreference
              })
              terminal.clearSelection()
            },
            hover: () => {
              hoverToken += 1
              const token = hoverToken
              deps.linkTooltip.textContent = `${parsed.url} (${deps.openLinkHint})`
              deps.linkTooltip.style.display = ''
              void Promise.resolve(deps.formatTooltip?.(parsed.url, deps.openLinkHint)).then(
                (formatted) => {
                  if (token === hoverToken && formatted) {
                    deps.linkTooltip.textContent = formatted
                  }
                },
                () => undefined
              )
            },
            leave: () => {
              hoverToken += 1
              deps.linkTooltip.style.display = 'none'
            }
          }
          callback([link])
          return
        }
      }

      callback(undefined)
    }
  }
}
