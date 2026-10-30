import type { TerminalFactSubject } from '../terminal-fact-subject'
import type { PaneLaunchAgentPaneSlice } from './pane-launch-agent-candidate'
import type { RecognizedAgentProcess } from '../../../../../shared/agent-process-recognition'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'

export type TerminalForegroundServices = {
  paneKey: string
  worktreeId: string
  tabId: string
  cwd: string
  startup: PaneLaunchAgentPaneSlice['startup']
  getPtyId: () => string | null
  getExpectedIncarnationId: () => string | null
  isVisible: () => boolean
  observeForegroundAgentProcess: (process: RecognizedAgentProcess) => void
  onConfirmedShellForeground: (reason: 'command-finished' | 'visible-pty' | 'process-exit') => void
  flushPendingInterruptInference: () => boolean | Promise<boolean>
  dropCommandFinishedStatusIfSameTurn: (
    entry: AgentStatusEntry | undefined,
    options?: { allowInferredInterrupt?: boolean; subject?: TerminalFactSubject }
  ) => void
}
