import type { IDisposable, Terminal } from '@xterm/xterm'
import { extractTerminalFileLinks, type ParsedTerminalFileLink } from '@/lib/terminal-links'
import {
  buildWrappedLogicalLine,
  rangeForParsedFileLink
} from '@/components/terminal-pane/wrapped-terminal-link-ranges'
import { isTerminalLinkDirectActivation } from '@/components/terminal-pane/terminal-link-activation'
import { getTerminalFileOpenHint } from '@/components/terminal-pane/terminal-link-open-hints'

/** A followed file link, as the agent's terminal printed it. */
export type PreviewFileLinkActivation = {
  path: string
  line: number | null
  column: number | null
  /** Shift+Mod-click: hand the file to the OS default app, as a pane does. */
  openWithSystemDefault: boolean
}

export type PreviewTerminalFileLinkDeps = {
  activate: (activation: PreviewFileLinkActivation) => void
  hover?: (text: string) => void
  leave?: () => void
}

// Why: a pane promotes a bare filename to a link only once it resolves against
// that pane's cwd, which the preview cannot probe — it has neither the pane cwd
// nor filesystem access to the agent's host. Claiming separator paths only keeps
// `README` plain text instead of a link that opens nothing.
function carriesPathSeparator(link: ParsedTerminalFileLink): boolean {
  return link.pathText.includes('/') || link.pathText.includes('\\')
}

/**
 * Makes file paths in the preview clickable under the same Mod+click gesture a
 * pane uses. Resolving the path against its workspace and opening the editor
 * both belong to the main renderer, so activation only reports what was
 * printed — see the `activate` dep.
 */
export function installPreviewTerminalFileLinks(
  terminal: Terminal,
  deps: PreviewTerminalFileLinkDeps
): IDisposable {
  return terminal.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      const logicalLine = buildWrappedLogicalLine(terminal.buffer.active, bufferLineNumber)
      if (!logicalLine?.text) {
        callback(undefined)
        return
      }
      const links = extractTerminalFileLinks(logicalLine.text)
        .filter(carriesPathSeparator)
        .flatMap((parsed) => {
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (!range) {
            return []
          }
          return [
            {
              range,
              text: parsed.displayText,
              activate: (event: MouseEvent) => {
                if (!isTerminalLinkDirectActivation(event)) {
                  return
                }
                event.preventDefault()
                deps.activate({
                  path: parsed.pathText,
                  line: parsed.line,
                  column: parsed.column,
                  openWithSystemDefault: event.shiftKey === true
                })
                terminal.clearSelection()
              },
              hover: () =>
                deps.hover?.(`${parsed.displayText} (${getTerminalFileOpenHint(false)})`),
              leave: () => deps.leave?.()
            }
          ]
        })
      callback(links.length > 0 ? links : undefined)
    }
  })
}
