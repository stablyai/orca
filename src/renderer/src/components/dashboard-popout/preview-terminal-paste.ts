import { getShortcutPlatform } from '@/lib/shortcut-platform'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteSource,
  type TerminalPasteTextOptions
} from '@/components/terminal-pane/terminal-paste-coordinator'
import { resolveTerminalPasteRuntime } from '@/components/terminal-pane/terminal-paste-runtime'
import { pasteTerminalText } from '@/components/terminal-pane/terminal-bracketed-paste'
import { pasteTerminalClipboard } from '@/components/terminal-pane/terminal-clipboard-paste'
import type { DashboardCardTerminalInput } from '../../../../shared/dashboard-snapshot'

type PreviewPasteTerminal = Parameters<typeof pasteTerminalText>[0]

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
  getTerminal: () => PreviewPasteTerminal | null
  getTerminalInput: () => DashboardCardTerminalInput | null
  isDisposed: () => boolean
}): (activeElementAtDispatch: Element | null, source: PreviewTerminalPasteSource) => Promise<void> {
  return async (activeElementAtDispatch, source) => {
    const pasteTerminal = deps.getTerminal()
    if (!pasteTerminal) {
      return
    }
    const terminalInput = deps.getTerminalInput()
    const targetIsCurrent = (): boolean =>
      !deps.isDisposed() &&
      deps.getTerminal() === pasteTerminal &&
      deps.getTerminalInput()?.connectionId === terminalInput?.connectionId &&
      deps.getTerminalInput()?.runtimeEnvironmentId === terminalInput?.runtimeEnvironmentId &&
      activeElementAtDispatch !== null &&
      document.activeElement === activeElementAtDispatch &&
      deps.container.contains(activeElementAtDispatch)
    // Why: checked before the clipboard read too — an image paste writes a file
    // on the pty's host, which must not happen for a card that lost focus.
    if (!targetIsCurrent()) {
      return
    }
    const pasteText = createPreviewTextPaster({
      ptyId: deps.ptyId,
      terminal: pasteTerminal,
      terminalInput,
      source,
      isTargetCurrent: targetIsCurrent
    })
    await pasteTerminalClipboard({
      readClipboardText: (options) => window.api.ui.readClipboardText(options),
      saveClipboardImageAsTempFile: (args) =>
        targetIsCurrent()
          ? window.api.ui.saveClipboardImageAsTempFile(args)
          : Promise.resolve(null),
      connectionId: terminalInput?.connectionId ?? null,
      runtimeEnvironmentId: terminalInput?.runtimeEnvironmentId ?? null,
      pasteText
    })
  }
}

export function createPreviewTextPaster(deps: {
  ptyId: string
  terminal: PreviewPasteTerminal
  terminalInput: DashboardCardTerminalInput | null
  source: TerminalPasteSource
  isTargetCurrent: () => boolean
}): (text: string, options?: TerminalPasteTextOptions) => Promise<boolean> {
  return async (text: string, options?: TerminalPasteTextOptions): Promise<boolean> => {
    if (!text || !deps.isTargetCurrent()) {
      return false
    }
    const platform = deps.terminalInput?.hostPlatform ?? getShortcutPlatform()
    const plan = await planTerminalPasteWithYield({
      text,
      source: deps.source,
      target: {
        kind: 'terminal',
        paneId: 0,
        leafId: deps.ptyId,
        ptyId: deps.ptyId,
        runtime: resolveTerminalPasteRuntime({
          platform,
          ptyId: deps.ptyId,
          connectionId: deps.terminalInput?.connectionId
        })
      },
      forceBracketedPaste: options?.forceBracketedPaste,
      forceBracketedPasteForMultiline: deps.terminalInput?.forceBracketedMultilineTextPaste,
      windowsInputRecordNewline: deps.terminalInput?.windowsInputRecordPasteNewline,
      terminalBracketedPasteMode: deps.terminal.modes.bracketedPasteMode
    })
    const execution = await executeTerminalPastePlan(plan, {
      // Why: stream large pastes so the renderer never emits one huge IPC payload.
      pasteText: (chunk, chunkOptions) => pasteTerminalText(deps.terminal, chunk, chunkOptions),
      writePty: (data) => window.api.terminalPreview.input(deps.ptyId, data),
      isTargetCurrent: deps.isTargetCurrent,
      // Why: if focus changes mid-bracketed paste, the closing marker must still reach the live PTY.
      canContinue: () => true
    })
    // The preview renders with the DOM renderer, so the image path's WebGL atlas recovery has nothing to do.
    return execution.status === 'pasted'
  }
}
