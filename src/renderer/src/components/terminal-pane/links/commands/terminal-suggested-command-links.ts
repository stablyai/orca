import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

import { translate } from '@/i18n/i18n'
import {
  findTerminalSuggestedCommand,
  type TerminalSuggestedCommand
} from '../../../../../../shared/terminal/links/terminal-suggested-command-detection'
import { pasteTerminalText } from '../../input/paste/terminal-bracketed-paste'
import {
  isTerminalLinkDirectActivation,
  isTerminalOwnedLinkGesture
} from '../gestures/terminal-link-activation'
import { getTerminalCommandRunHint } from '../terminal-link-open-hints'
import {
  requestTerminalLinkAction,
  type TerminalLinkActionContext
} from '../terminal-link-action-request'

type SuggestedCommandLinkDeps = {
  getTerminal: () => Terminal | null
  linkTooltip: HTMLElement
  getLinkActionContext?: () => TerminalLinkActionContext | null
}

// Why: some TUIs read a paste and Enter in one chunk as a multi-line paste instead of a submit.
const SUBMIT_AFTER_PASTE_DELAY_MS = 30

/** Types the command the way the user would: paste it, then press Enter. */
export function runTerminalSuggestedCommand(
  terminal: Pick<Terminal, 'input' | 'focus' | 'modes' | 'options' | 'paste' | 'element'>,
  text: string
): void {
  terminal.focus()
  pasteTerminalText(terminal, text)
  setTimeout(() => {
    // The pane can close in the gap; a disposed xterm has no element.
    if (terminal.element?.isConnected) {
      terminal.input('\r')
    }
  }, SUBMIT_AFTER_PASTE_DELAY_MS)
}

export function createTerminalSuggestedCommandLinkProvider(
  deps: SuggestedCommandLinkDeps
): ILinkProvider {
  return {
    provideLinks: (bufferLineNumber, callback) => {
      const terminal = deps.getTerminal()
      if (!terminal) {
        callback(undefined)
        return
      }
      const find = (): TerminalSuggestedCommand | null => {
        const buffer = terminal.buffer.active
        return findTerminalSuggestedCommand(buffer, bufferLineNumber, buffer.baseY + buffer.cursorY)
      }
      const command = find()
      if (!command) {
        callback(undefined)
        return
      }
      const run = (): void => {
        // Why: agent TUIs repaint rows, and the setting may turn off while the popover is open.
        if (deps.getTerminal() === terminal && find()?.text === command.text) {
          runTerminalSuggestedCommand(terminal, command.text)
        }
      }
      const link: ILink = {
        range: command.range,
        text: command.text,
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => {
          if (!isTerminalOwnedLinkGesture(event)) {
            return
          }
          if (isTerminalLinkDirectActivation(event)) {
            event?.preventDefault()
            terminal.clearSelection()
            run()
            return
          }
          const handled = requestTerminalLinkAction(event, deps.getLinkActionContext?.(), {
            destination: command.text,
            kind: 'command',
            primary: {
              label: translate(
                'auto.components.terminal.pane.TerminalLinkActionPopover.runCommand',
                'Run in this terminal'
              ),
              run
            }
          })
          if (handled) {
            terminal.clearSelection()
          }
        },
        hover: () => {
          const context = deps.getLinkActionContext?.()
          // Only the 'actions' behavior opens the popover on a plain click.
          const showActions = deps.getLinkActionContext
            ? context != null && (context.plainClickBehavior ?? 'actions') === 'actions'
            : true
          deps.linkTooltip.textContent = `${command.text} (${getTerminalCommandRunHint(showActions)})`
          deps.linkTooltip.style.display = ''
        },
        leave: () => {
          deps.linkTooltip.style.display = 'none'
        }
      }
      callback([link])
    }
  }
}
