import type { Terminal } from '@xterm/xterm'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteTextOptions
} from '@/components/terminal-pane/terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from '@/components/terminal-pane/terminal-paste-runtime'
import { pasteTerminalText } from '@/components/terminal-pane/terminal-bracketed-paste'
import { pasteTerminalClipboard } from '@/components/terminal-pane/terminal-clipboard-paste'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

export type PreviewTerminalPasteSource = 'keyboard' | 'app-menu' | 'right-click'

/**
 * Clipboard paste for the preview terminal, on the pane's coordinator: large
 * pastes stream as bounded IPC payloads, and the plan re-checks that the same
 * terminal still owns focus between chunks. Text first, then an image-only
 * clipboard as a temp file on the pty's host — the same order as the pane.
 */
export function createPreviewClipboardPaster(deps: {
  ptyId: string
  container: HTMLElement
  getTerminal: () => Terminal | null
  getTerminalInput: () => DashboardCardTerminalInput | null
  isDisposed: () => boolean
}): (activeElementAtDispatch: Element | null, source: PreviewTerminalPasteSource) => Promise<void> {
  return async (activeElementAtDispatch, source) => {
    const pasteTerminal = deps.getTerminal()
    if (!pasteTerminal) {
      return
    }
    const targetIsCurrent = (): boolean =>
      !deps.isDisposed() &&
      deps.getTerminal() === pasteTerminal &&
      activeElementAtDispatch !== null &&
      document.activeElement === activeElementAtDispatch &&
      deps.container.contains(activeElementAtDispatch)
    // Why: checked before the clipboard read too — an image paste writes a file
    // on the pty's host, which must not happen for a card that lost focus.
    if (!targetIsCurrent()) {
      return
    }
    const terminalInput = deps.getTerminalInput()
    const pasteText = async (
      text: string,
      options?: TerminalPasteTextOptions
    ): Promise<boolean> => {
      if (!text || !targetIsCurrent()) {
        return false
      }
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
        forceBracketedPaste: options?.forceBracketedPaste,
        forceBracketedPasteForMultiline: terminalInput?.forceBracketedMultilineTextPaste,
        windowsInputRecordNewline: terminalInput?.windowsInputRecordPasteNewline,
        terminalBracketedPasteMode: pasteTerminal.modes.bracketedPasteMode
      })
      const execution = await executeTerminalPastePlan(plan, {
        // Why: stream large pastes so the renderer never emits one huge IPC payload.
        pasteText: (chunk, chunkOptions) => pasteTerminalText(pasteTerminal, chunk, chunkOptions),
        writePty: (data) => window.api.terminalPreview.input(deps.ptyId, data),
        isTargetCurrent: targetIsCurrent,
        // Why: if focus changes mid-bracketed paste, the closing marker must still reach the live PTY.
        canContinue: () => true
      })
      // The preview renders with the DOM renderer, so the image path's WebGL atlas recovery has nothing to do.
      return execution.status === 'pasted'
    }
    await pasteTerminalClipboard({
      readClipboardText: (options) => window.api.ui.readClipboardText(options),
      saveClipboardImageAsTempFile: (args) => window.api.ui.saveClipboardImageAsTempFile(args),
      connectionId: terminalInput?.connectionId ?? null,
      runtimeEnvironmentId: terminalInput?.runtimeEnvironmentId ?? null,
      pasteText
    })
  }
}
