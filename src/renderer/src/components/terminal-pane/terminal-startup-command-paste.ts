import type { PtyTransport } from './pty-transport'
import { pasteTerminalText } from './terminal-bracketed-paste'
import {
  executeTerminalPastePlan,
  planTerminalPasteWithYield,
  type TerminalPasteExecutionResult,
  type TerminalPasteRuntime
} from './terminal-paste-coordinator'
import { writeTerminalPastePtyInput } from './terminal-pty-paste-writer'
import { TERMINAL_INPUT_CHUNK_MAX_BYTES } from '../../../../shared/terminal-input'

type StartupCommandPane = {
  id: number
  leafId: string
  terminal: Parameters<typeof pasteTerminalText>[0]
}

type ExecuteTerminalStartupCommandPasteArgs = {
  command: string
  submit?: boolean
  pane: StartupCommandPane
  ptyId: string | null
  runtime: TerminalPasteRuntime
  transport: Pick<PtyTransport, 'sendInput' | 'sendInputAccepted' | 'sendInputSettled'>
  isTargetCurrent?: (ptyId: string | null) => boolean
}

export async function executeTerminalStartupCommandPaste({
  command,
  submit,
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
    terminalBracketedPasteMode: pane.terminal.modes?.bracketedPasteMode === true,
    // Startup ownership may be released only after an acknowledged PTY write;
    // xterm's direct paste path cannot report transport rejection.
    maxDirectBytes: 0
  })

  return executeTerminalPastePlan(plan, {
    pasteText: (text, options) => pasteTerminalText(pane.terminal, text, options),
    writePty: (data) => writeTerminalPastePtyInput(transport, data),
    isTargetCurrent: isCurrent,
    canContinue: isCurrent,
    // One settled write avoids replaying a half-open bracketed frame after a
    // transient disconnect. Larger payloads retain the bounded chunked path.
    combineChunkedWritesUpToBytes: TERMINAL_INPUT_CHUNK_MAX_BYTES,
    ...(submit === false ? {} : { appendToChunkedWrite: '\r' })
  })
}
