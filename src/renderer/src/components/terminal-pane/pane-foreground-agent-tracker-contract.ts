import type { RecognizedAgentProcess } from '../../../../shared/agent-process-recognition'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
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
  /** Actual live hook evidence, excluding launch and restored display hints. */
  hasKnownAgentIdentity?: () => boolean
  hasAgentExpectation?: () => boolean
  /** The known agent type that owns the pane now, or null. */
  getObservationOwner?: () => string | null
  /** Positive shell ownership releases presentation independently of lifetime. */
  onConfirmedShellForeground?: (
    reason: 'visible-pty' | 'command-finished' | 'process-exit'
  ) => boolean | void
  onCommandFinishedUnavailable?: () => void
  onVisibleForegroundSettled?: (outcome: 'agent' | 'shell' | 'inconclusive') => void
}

/** A read is stale only when a different known agent took the pane; a row ending or clearing is not a new owner. */
export function isObservationOwnerSuperseded(
  ownerAtRequest: string | null | undefined,
  ownerNow: string | null | undefined
): boolean {
  return Boolean(ownerNow) && ownerNow !== ownerAtRequest
}

export type PaneForegroundAgentTracker = {
  /** True while any read is scheduled or running, whatever its authority. */
  hasReadInFlight: () => boolean
  onVisiblePtyBound: (expectsAgent?: boolean) => boolean
  onCommandStarted: (expectedAgent?: TerminalAgent | null) => void
  onAgentStartupObserved: () => void
  /** True when pane identity must remain visible until an async shell confirmation. */
  onCommandFinished: () => boolean
  /** The process monitor confirmed this agent exited (no agent, no children, settled). */
  onProcessExitConfirmed: (process: RecognizedAgentProcess) => void
  onForegroundAgentObserved: (process: RecognizedAgentProcess) => void
  onShellForegroundObserved: () => void
  dispose: () => void
}
