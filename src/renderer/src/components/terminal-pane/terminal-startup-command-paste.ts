import type { PtyTransport } from './pty-transport'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteExecutionResult,
  type TerminalPasteRuntime
} from './terminal-paste-coordinator'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'

type StartupCommandPane = {
  id: number
  leafId: string
  terminal: Parameters<typeof pasteTerminalText>[0]
}

type ExecuteTerminalStartupCommandPasteArgs = {
  command: string
  pane: StartupCommandPane
  ptyId: string | null
  runtime: TerminalPasteRuntime
  transport: Pick<PtyTransport, 'sendInput'>
  isTargetCurrent?: (ptyId: string | null) => boolean
}

export async function executeTerminalStartupCommandPaste({
  command,
  pane,
  ptyId,
  runtime,
  transport,
  isTargetCurrent
}: ExecuteTerminalStartupCommandPasteArgs): Promise<TerminalPasteExecutionResult> {
  const isCurrent = (): boolean => isTargetCurrent?.(ptyId) ?? true
  const plan = await planTerminalPasteWithYield({
    text: command,
    source: 'programmatic',
    target: {
      kind: 'terminal',
      paneId: pane.id,
      leafId: pane.leafId,
      ptyId,
      runtime
    },
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true
  })

  return executeTerminalPastePlan(plan, {
    pasteText: (text, options) => pasteTerminalText(pane.terminal, text, options),
    writePty: (data) => writeTerminalPastePtyInput(transport, data),
    isTargetCurrent: isCurrent,
    canContinue: isCurrent
  })
}
