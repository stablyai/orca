import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { executeTerminalPastePlan } from '@/components/terminal-pane/terminal-paste-executor'
import { planTerminalPasteWithYield } from '@/components/terminal-pane/terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from '@/components/terminal-pane/terminal-paste-runtime'
import { TERMINAL_PASTE_MAX_BYTES } from '@/components/terminal-pane/terminal-paste-limits'
import { pasteTerminalText } from '@/components/terminal-pane/terminal-bracketed-paste'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

export type PreviewTerminalPasteSource = 'keyboard' | 'app-menu' | 'right-click'

/** Stream bounded paste chunks through the pane coordinator, rechecking focus ownership between chunks. */
export function createPreviewClipboardPaster(deps: {
  /** Names the session for paste planning; a remote-runtime pty id routes as remote. */
  ptyId: string
  /** Where pasted bytes go when they bypass xterm, e.g. a bracketed paste's closing marker. */
  writeInput: (data: string) => boolean | Promise<boolean>
  container: HTMLElement
  getTerminal: () => Terminal | null
  getTerminalInput: () => DashboardCardTerminalInput | null
  isDisposed: () => boolean
}): (activeElementAtDispatch: Element | null, source: PreviewTerminalPasteSource) => Promise<void> {
  return async (activeElementAtDispatch, source) => {
    let text: string
    try {
      text = await window.api.ui.readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
    } catch {
      return
    }
    const pasteTerminal = deps.getTerminal()
    if (!pasteTerminal || !text) {
      return
    }
    const targetIsCurrent = (): boolean =>
      !deps.isDisposed() &&
      deps.getTerminal() === pasteTerminal &&
      activeElementAtDispatch !== null &&
      document.activeElement === activeElementAtDispatch &&
      deps.container.contains(activeElementAtDispatch)
    if (!targetIsCurrent()) {
      return
    }
    const terminalInput = deps.getTerminalInput()
    const platform = terminalInput?.hostPlatform ?? getShortcutPlatform()
    const plan = await planTerminalPasteWithYield({
      text,
      source,
      target: {
        kind: 'terminal',
        paneId: 0,
        leafId: deps.ptyId,
        ptyId: deps.ptyId,
        runtime: resolveTerminalPasteRuntime({ platform, ptyId: deps.ptyId })
      },
      forceBracketedPasteForMultiline: terminalInput?.forceBracketedMultilineTextPaste,
      windowsInputRecordNewline: terminalInput?.windowsInputRecordPasteNewline,
      terminalBracketedPasteMode: pasteTerminal.modes.bracketedPasteMode
    })
    await executeTerminalPastePlan(plan, {
      pasteText: (text, options) => pasteTerminalText(pasteTerminal, text, options),
      writePty: (data) => deps.writeInput(data),
      isTargetCurrent: targetIsCurrent,
      // Why: if focus changes mid-bracketed paste, the closing marker must still reach the live PTY.
      canContinue: () => true
    })
  }
}
