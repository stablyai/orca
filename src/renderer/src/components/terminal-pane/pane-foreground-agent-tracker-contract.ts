import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   * their replayed OSC streams must not produce process evidence. */
  isTrackablePtyId: (ptyId: string) => boolean
  readForegroundProcess: (
    ptyId: string,
    options?: { expectedIncarnationId?: string }
  ) => Promise<string | null | RuntimeTerminalProcessInspection>
  /** Fresh, provider-owned evidence used only when input routing may change. */
  confirmForegroundProcess?: (
    ptyId: string,
    options?: { expectedIncarnationId?: string }
  ) => Promise<string | null | RuntimeTerminalProcessInspection>
  /** Remote authorities must provide fenced evidence; local panes retain the string path. */
  isRemotePtyId?: (ptyId: string) => boolean
  getExpectedIncarnationId?: () => string | null
  publish: (entry: PaneForegroundAgentEntry) => void
  /** The entry currently published for this pane, whoever wrote it. */
  getPublishedEntry?: () => PaneForegroundAgentEntry | undefined
  /** A local read recognized an agent; lets the pane's process monitor watch for its exit. */
  onAgentProcessRead?: (process: RecognizedAgentProcess) => void
  /** Launch/hook evidence retained until a foreground read confirms ownership. */
  hasKnownAgentIdentity?: () => boolean
  /** Clears an agent title only after a confirmed foreground shell or process exit. */
  onConfirmedShellForeground?: (reason: 'visible-pty' | 'command-finished' | 'process-exit') => void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
}

export type PaneForegroundAgentTracker = {
  /** True while any read is scheduled or running, whatever its authority. */
  hasReadInFlight: () => boolean
  onVisiblePtyBound: (expectsAgent?: boolean) => boolean
  onCommandStarted: (expectedAgent?: TuiAgent | null) => void
  /** True when pane identity must remain visible until an async shell confirmation. */
  onCommandFinished: () => boolean
  resetForPtyReplacement: () => void
  /** The process monitor confirmed this agent exited (no agent, no children, settled). */
  onProcessExitConfirmed: (process: RecognizedAgentProcess) => void
  dispose: () => void
}
