import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'

export type ForegroundReadReason = 'command' | 'visible-pty' | 'command-finished'

export type PaneForegroundAgentTrackerDeps = {
  getPtyId: () => string | null
  /** Local panes only — remote/SSH foreground reads are expensive RPCs and
   *  their replayed OSC streams must not produce process evidence. */
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
  /** True when the pane is otherwise known to run an agent (launchAgent, live
   *  hook status). Lets a restored agent pane confirm — rather than trust — a
   *  133;D before any command-start read has recorded its own evidence. */
  hasKnownAgentIdentity?: () => boolean
  /** Fired when a confirming read proves the foreground genuinely returned to a
   *  shell (agent exited). Lets callers clear a stale agent-named tab title that
   *  the shell never repaints. */
  onConfirmedShellForeground?: (reason: 'visible-pty' | 'command-finished' | 'process-exit') => void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
}
