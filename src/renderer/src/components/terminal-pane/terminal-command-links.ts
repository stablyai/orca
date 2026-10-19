import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { buildWrappedLogicalLine, rangeForParsedFileLink } from './wrapped-terminal-link-ranges'
import {
  isTerminalLinkActionActivation,
  isTerminalLinkDirectActivation
} from './terminal-link-activation'
import { recordTerminalUserInputForLeaf } from './terminal-input-activity'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import type { PtyTransport } from './pty-transport-types'

export type ParsedShellCommandLink = {
  command: string
  startIndex: number
  endIndex: number
}

const MAX_SHELL_COMMAND_LENGTH = 2048
const INSERT_COMMAND_HINT = 'Click to type this command into the terminal'

/**
 * Detects a Claude Code bang-command suggestion (`! cmd` or `!cmd`) as the trailing content of a
 * line, so it can be inserted into the terminal with one click. Kept conservative — the bang must
 * start the command (optionally after a marker like a bullet) and be followed by an actual command.
 */
export function extractShellCommandLinks(lineText: string): ParsedShellCommandLink[] {
  const match = lineText.match(/(^|\s)(!\s?\S.*?)\s*$/)
  if (!match || match[2] === undefined) {
    return []
  }
  const command = match[2]
  // Reject bare bangs and bash history expansions (`!`, `!!`), and runaway lines.
  if (/^!+$/.test(command.replace(/\s+/g, '')) || command.length > MAX_SHELL_COMMAND_LENGTH) {
    return []
  }
  const startIndex = (match.index ?? 0) + match[1].length
  return [{ command, startIndex, endIndex: startIndex + command.length }]
}

/** Types a suggested command into a pane without a trailing return, so it is not executed. */
export function insertSuggestedCommandIntoPane(args: {
  transport: Pick<PtyTransport, 'sendInput'> | null | undefined
  tabId: string
  leafId: string
  focus: () => void
  command: string
}): boolean {
  if (!args.transport) {
    return false
  }
  const sent = args.transport.sendInput(args.command, 'driving')
  if (sent) {
    recordTerminalUserInputForLeaf(args.tabId, args.leafId)
    args.focus()
  }
  return sent
}

type ShellCommandLinkProviderDeps = {
  getTerminal: () => Terminal | null
  linkTooltip: HTMLElement
  getLinkActionContext: () => TerminalLinkActionContext | null
  insertCommand: (command: string) => boolean
}

/** One click on a suggested `! command` types it into the terminal input without running it. */
export function createShellCommandLinkProvider(deps: ShellCommandLinkProviderDeps): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      if (!terminal) {
        callback(undefined)
        return
      }
      const logicalLine = buildWrappedLogicalLine(terminal.buffer.active, bufferLineNumber)
      if (!logicalLine || !logicalLine.text.includes('!')) {
        callback(undefined)
        return
      }
      const links = extractShellCommandLinks(logicalLine.text)
        .map((parsed): ILink | null => {
          const range = rangeForParsedFileLink(logicalLine, parsed.startIndex, parsed.endIndex)
          if (!range) {
            return null
          }
          return {
            range,
            text: parsed.command,
            activate: (event) => {
              if (
                !isTerminalLinkActionActivation(event) &&
                !isTerminalLinkDirectActivation(event)
              ) {
                return
              }
              const context = deps.getLinkActionContext()
              if (!context || !context.pointerGesture.canRequestAction(event)) {
                return
              }
              if (!context.claimPtyMouse()) {
                return
              }
              event?.preventDefault()
              if (deps.insertCommand(parsed.command)) {
                terminal.clearSelection()
              }
            },
            hover: () => {
              deps.linkTooltip.textContent = INSERT_COMMAND_HINT
              deps.linkTooltip.style.display = ''
            },
            leave: () => {
              deps.linkTooltip.style.display = 'none'
            }
          }
        })
        .filter((link): link is ILink => link !== null)
      callback(links.length > 0 ? links : undefined)
    }
  }
}
