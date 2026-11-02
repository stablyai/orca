import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type ForegroundReadReason = 'command' | 'visible-pty' | 'command-finished'

export type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local reads only: remote RPC cost and replayed OSC streams must not produce process evidence. */
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
  /** Launch/hook identity requires confirmation of 133;D even before any command-start read found the agent. */
  hasKnownAgentIdentity?: () => boolean
  /** Confirmed shell return lets callers clear an agent title the shell will not repaint. */
  onConfirmedShellForeground?: (reason: 'visible-pty' | 'command-finished' | 'process-exit') => void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
}
