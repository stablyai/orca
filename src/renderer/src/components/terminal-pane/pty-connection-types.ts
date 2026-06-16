import type { PtyTransport } from './pty-transport'
import type { ReplayingPanesRef } from './replay-guard'
import type { AgentCompletionStatusSnapshot } from './agent-completion-coordinator-types'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalColorSchemeMode } from '../../../../shared/terminal-color-scheme-protocol'
import type { TuiAgent } from '../../../../shared/types'

export type PtyConnectionDeps = {
  tabId: string
  worktreeId: string
  cwd?: string
  startup?: {
    command: string
    /** Renderer-delivered startup input for callers that need xterm paste
     *  semantics before the submit Enter. */
    delivery?: 'terminal-paste'
    env?: Record<string, string>
    /** Telemetry payload for `agent_started`. Forwarded to `pty:spawn`
     *  so main fires the event only after the spawn succeeds. */
    telemetry?: EventProps<'agent_started'>
    /** Initial prompt-start status for agents that lack native prompt hooks. */
    initialAgentStatus?: { agent: TuiAgent; prompt: string }
  } | null
  restoredLeafId?: string | null
  restoredPtyIdByLeafId?: Record<string, string>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneMode2031Ref: React.RefObject<Map<number, boolean>>
  paneLastThemeModeRef: React.RefObject<Map<number, TerminalColorSchemeMode>>
  replayingPanesRef: ReplayingPanesRef
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  onPtyExitRef: React.RefObject<(ptyId: string) => void>
  onPtyErrorRef?: React.RefObject<(paneId: number, message: string) => void>
  clearTabPtyId: (tabId: string, ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  updateTabTitle: (tabId: string, title: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  markWorktreeUnread: (worktreeId: string) => void
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  clearWorktreeUnread: (worktreeId: string) => void
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  // Why: the renderer dispatches two notification sources — BEL from the PTY
  // byte stream and agent-task-complete on the working→idle title transition.
  // shared/types.ts keeps a wider NotificationEventSource union because the
  // main process can also emit `'test'` from the settings-pane button.
  dispatchNotification: (event: {
    source: 'terminal-bell' | 'agent-task-complete'
    terminalTitle?: string
    paneKey?: string
    agentStatusSnapshot?: AgentCompletionStatusSnapshot
    suppressOsNotification?: boolean
  }) => void
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => void
}
