import type { PtyTransport } from '../../pty-transport/pty-transport-types'
import { pasteTerminalText } from './terminal-bracketed-paste'
import { isTerminalStartingForPaste } from './terminal-paste-startup-window'
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
  transport: Pick<PtyTransport, 'sendInput' | 'sendInputAccepted' | 'isHoldingInput'> | undefined
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
  // Why: before the program enables bracketed paste, a raw line break in a user's paste submits as Enter.
  const userPasteIntoStartingTerminal =
    source !== 'programmatic' &&
    (transport?.isHoldingInput?.() === true || isTerminalStartingForPaste(pane.terminal))
  const plan = await planTerminalPasteWithYield({
    text,
    source,
    target: { kind: 'terminal', paneId: pane.id, leafId: pane.leafId, ptyId, runtime },
    forceBracketedPaste: planOptions?.forceBracketedPaste,
    forceBracketedPasteForMultiline:
      planOptions?.forceBracketedPasteForMultiline === true || userPasteIntoStartingTerminal,
    windowsInputRecordNewline: planOptions?.windowsInputRecordNewline,
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true
  })
  // Why: a held terminal takes a paste only as one entry, like a typed key; chunks need a bound, live PTY.
  const isHolding = (): boolean => transport?.isHoldingInput?.() === true
  return executeTerminalPastePlan(plan, {
    pasteText: (pasteText, pasteOptions) =>
      pasteTerminalText(pane.terminal, pasteText, pasteOptions),
    writePty:
      ptyId !== null && !isHolding()
        ? (data, signal) => writeTerminalPastePtyInput(transport, data, inputKind, signal)
        : undefined,
    isTargetCurrent,
    canContinue: () => canContinue() && !isHolding()
  })
}
