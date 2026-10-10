import type { PtyTransport } from './pty-transport'
import type { pasteTerminalText } from './terminal-bracketed-paste'
import type {
  TerminalPasteExecutionResult,
  TerminalPasteRuntime
} from './terminal-paste-coordinator'
import { pasteTextIntoTerminalPane } from './terminal-pane-paste-dispatch'

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
  return pasteTextIntoTerminalPane({
    pane,
    text: command,
    source: 'programmatic',
    ptyId,
    runtime,
    transport,
    inputKind: 'launch',
    isTargetCurrent: isCurrent,
    canContinue: isCurrent
  })
}
