import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteExecutionResult,
  type TerminalPasteRuntime,
  type TerminalPasteSource,
  type TerminalPasteTextOptions
} from './terminal-paste-coordinator'
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
  planOptions
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
  return executeTerminalPastePlan(plan, {
    pasteText: (pasteText, pasteOptions) =>
      pasteTerminalText(pane.terminal, pasteText, pasteOptions),
    writePty: (data, signal) => writeTerminalPastePtyInput(transport, data, inputKind, signal),
    isTargetCurrent,
    canContinue
  })
}
