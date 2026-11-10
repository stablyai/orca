import type { PtyPreconnectPasteHold } from '../../pty-transport/input/pty-preconnect-input-buffer'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { executeTerminalPastePlan } from './terminal-paste-executor'
import { planTerminalPasteWithYield } from './terminal-paste-coordinator'
import type {
  TerminalPasteExecutionResult,
  TerminalPasteRuntime,
  TerminalPasteSource,
  TerminalPasteTextOptions
} from './terminal-paste-model'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

type PasteTextIntoTerminalPaneArgs = {
  pane: { id: number; leafId: string; terminal: Parameters<typeof pasteTerminalText>[0] }
  text: string
  source: TerminalPasteSource
  ptyId: string | null
  runtime: TerminalPasteRuntime
  transport: Parameters<typeof writeTerminalPastePtyInput>[0]
  inputKind: 'driving' | 'launch'
  isTargetCurrent: () => boolean
  canContinue: () => boolean
  planOptions?: Pick<
    TerminalPasteTextOptions,
    'forceBracketedPaste' | 'forceBracketedPasteForMultiline' | 'windowsInputRecordNewline'
  >
  /** Opened before the clipboard read so paste bytes stay ahead of keys typed during that read. */
  holdPaste?: PtyPreconnectPasteHold | null
}

/** Only a not-yet-bound pane may reserve a paste slot. A disconnected live PTY keeps rejecting paste. */
export function openUnboundTerminalPasteHold(
  transport:
    | Pick<PtyTransport, 'getPtyId' | 'holdPasteAheadOfLaterKeys' | 'isConnected'>
    | null
    | undefined
): PtyPreconnectPasteHold | null {
  if (!transport || transport.isConnected() || transport.getPtyId() !== null) {
    return null
  }
  return transport.holdPasteAheadOfLaterKeys?.() ?? null
}

export async function pasteTextIntoTerminalPane({
  pane,
  text,
  source,
  ptyId,
  runtime,
  transport,
  inputKind,
  isTargetCurrent,
  canContinue,
  planOptions,
  holdPaste
}: PasteTextIntoTerminalPaneArgs): Promise<TerminalPasteExecutionResult> {
  const plan = await planTerminalPasteWithYield({
    text,
    source,
    target: { kind: 'terminal', paneId: pane.id, leafId: pane.leafId, ptyId, runtime },
    forceBracketedPaste: planOptions?.forceBracketedPaste,
    forceBracketedPasteForMultiline: planOptions?.forceBracketedPasteForMultiline,
    windowsInputRecordNewline: planOptions?.windowsInputRecordNewline,
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true
  })
  // Only the synchronous write joins the gate. An await around it would also pull later keys forward.
  const sendHeld = <T>(run: () => T): T => (holdPaste ? holdPaste.insertIncoming(run) : run())
  return executeTerminalPastePlan(plan, {
    pasteText: (pasteText, pasteOptions) =>
      sendHeld(() => pasteTerminalText(pane.terminal, pasteText, pasteOptions)),
    writePty: (data, signal) =>
      sendHeld(() => writeTerminalPastePtyInput(transport, data, inputKind, signal)),
    isTargetCurrent,
    canContinue
  })
}
