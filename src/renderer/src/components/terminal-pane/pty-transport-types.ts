import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import type { TuiAgent } from '../../../../shared/types'
import type { PtyDataMeta } from './pty-dispatcher'

export type PtyBufferSnapshot = {
  data: string
  cols: number
  rows: number
  seq?: number
  source?: 'headless' | 'renderer'
  /** True when the snapshot captures an alternate-screen TUI (Claude Code,
   *  vim). Restore must NOT clear xterm's buffer in that case — the TUI's
   *  scrollback lives in xterm and a clear destroys scroll-up after a tab
   *  return. Mirrors the attach-time guard in pty-transport.ts. */
  alternateScreen?: boolean
}

export type LocalPtySessionMetadata = { cwd?: string; shellOverride?: string }

export type PtyConnectResult = {
  id: string
  launchConfig?: SleepingAgentLaunchConfig
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
  isAlternateScreen?: boolean
  sessionExpired?: boolean
  coldRestore?: { scrollback: string; cwd: string }
  replay?: string
}

type PtyCallbacks = {
  onConnect?: () => void
  onDisconnect?: () => void
  onData?: (data: string, meta?: PtyDataMeta) => void
  onReplayData?: (data: string, meta?: { clearBeforeReplay?: boolean }) => void
  onStatus?: (shell: string) => void
  onError?: (message: string, errors?: string[]) => void
  onExit?: (code: number) => void
}

export type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    sessionId?: string
    command?: string
    env?: Record<string, string>
    launchConfig?: SleepingAgentLaunchConfig
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    callbacks: PtyCallbacks
  }) => void | Promise<void | string | PtyConnectResult>
  attach: (options: {
    existingPtyId: string
    cols?: number
    rows?: number
    isAlternateScreen?: boolean
    callbacks: PtyCallbacks
  }) => void
  disconnect: () => void
  sendInput: (data: string) => boolean
  sendInputAccepted?: (data: string) => Promise<boolean>
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  getPtyId: () => string | null
  getConnectionId?: () => string | null | undefined
  getLocalSessionMetadata?: () => LocalPtySessionMetadata | null
  serializeBuffer?: (opts?: { scrollbackRows?: number }) => Promise<PtyBufferSnapshot | null>
  preserve?: () => void
  detach?: () => void
  destroy?: () => void | Promise<void>
}

export type IpcPtyTransportOptions = {
  cwd?: string
  env?: Record<string, string>
  command?: string
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  worktreeId?: string
  tabId?: string
  leafId?: string
  activate?: boolean
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  telemetry?: EventProps<'agent_started'>
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}
