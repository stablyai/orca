import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery
} from '../../../../shared/agent-session-host-authority'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { EventProps } from '../../../../shared/telemetry-events'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PtyDataMeta } from './pty-dispatcher'
import type { RemoteRuntimeSnapshotOutcome } from '../../runtime/remote-runtime-terminal-multiplexer'
import type { PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'

export type PtyBufferSnapshot = {
  data: string
  /** Live state that can be restored without an alternate-screen frame. */
  frameRestoreAnsi?: string
  cols: number
  rows: number
  seq?: number
  /** Lowest seq main could still deliver when the snapshot was taken (start
   *  of its pending renderer-delivery queue; equals `seq` when empty). Bytes
   *  are delivered once and in order, so a post-restore chunk at or below
   *  this seq can never be a duplicate the snapshot already covers. */
  pendingDeliveryStartSeq?: number
  source?: 'headless' | 'renderer'
  /** True when the snapshot captures an alternate-screen TUI (Claude Code,
   *  vim). Restore must NOT clear xterm's buffer in that case — the TUI's
   *  scrollback lives in xterm and a clear destroys scroll-up after a tab
   *  return. Mirrors the attach-time guard in pty-transport.ts. */
  alternateScreen?: boolean
  /** Authoritative normal buffer paired with an alternate-screen frame. */
  scrollbackAnsi?: string
  /** Trailing incomplete escape sequence main's emulator ingested (a PTY read
   *  ended mid-escape). Must be written LAST — after post-replay resets, right
   *  before post-snapshot live chunks — so the continuation completes it
   *  exactly as live instead of rendering literal (Bug E / #7329). */
  pendingEscapeTailAnsi?: string
  /** Effective kitty flags the owner of this image proved at `seq`. Absent
   *  means unknown; never rewrite that silence into a known `0`. */
  kittyKeyboardFlags?: number
  terminalOwner?: 'shell'
}

/** Metadata for one authoritative replay payload. */
export type PtyReplayDataMeta = {
  clearBeforeReplay?: boolean
  pendingEscapeTailAnsi?: string
  /** Kitty flags the snapshot's owner PROVED at `snapshotSeq`. Absent means
   *  unknown; the pane tracker must stay unproven rather than assume zero. */
  kittyKeyboardFlags?: number
  /** The boundary `kittyKeyboardFlags` describes, recorded as the renderer's
   *  ordered high-water so a quiet pane can still publish a coherent snapshot. */
  snapshotSeq?: number
  alternateScreen?: boolean
  terminalOwner?: 'shell'
  /** Grid the payload was serialized at. Present only when the producer proved
   *  it; the drain replays there and fits back to the pane afterwards. */
  snapshotCols?: number
  snapshotRows?: number
}

export type LocalPtySessionMetadata = {
  cwd?: string
  shellOverride?: string
}

export type PtyConnectResult = {
  id: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string
  /** The requested session exited while it had no primary pane handler. Its
   *  buffered final data/exit were delivered, so callers must not fresh-spawn. */
  exitedBeforeAttach?: boolean
  /** The provider adopted an existing session rather than creating a fresh one.
   *  Startup commands may be ignored; recovery still requires separate ownership evidence. */
  isReattach?: boolean
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  snapshot?: string
  snapshotCols?: number
  snapshotRows?: number
  /** Normal-buffer history and mode preamble before an alternate-screen frame. */
  snapshotPrefixAnsi?: string
  /** Visual alternate-screen frame. Both fields are absent on older hosts. */
  snapshotFrameAnsi?: string
  /** Live state to append when omitting `snapshotFrameAnsi`. */
  snapshotFrameRestoreAnsi?: string
  /** Kitty keyboard flags the daemon snapshot proved, paired with the renderer-
   *  domain `snapshotSeq` main reconciled for the same attach boundary. Absent
   *  means unknown, never a proven inactive protocol. */
  snapshotKittyKeyboardFlags?: number
  snapshotTerminalOwner?: 'shell'
  snapshotSeq?: number
  isAlternateScreen?: boolean
  sessionExpired?: boolean
  coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
  replay?: string
  startupCwdFallback?: { kind: 'worktree'; cwd: string }
  /** Main declined an unverifiable provider-session resume and launched fresh. */
  agentResumeUnavailable?: true
  /** Trailing partial escape the daemon emulator held mid-parse; the reattach
   *  replay writes it LAST (after the reset) so a racing live continuation
   *  completes it instead of rendering literally (#7329). */
  pendingEscapeTailAnsi?: string
}

type PtyCallbacks = {
  /** Called before an adopted PTY can publish buffered/live bytes. */
  onReattachDetermined?: () => void
  onConnect?: () => void
  /** A stream re-established after loss carries only new bytes, so the pane must
   *  re-pull the host's retained buffer or an idle/exited pane paints nothing. */
  onStreamRecovered?: () => void
  onDisconnect?: () => void
  onData?: (data: string, meta?: PtyDataMeta) => void
  onReplayData?: (data: string, meta?: PtyReplayDataMeta) => void
  onStatus?: (shell: string) => void
  onError?: (message: string, errors?: string[]) => void
  onErrorCleared?: (message: string) => void
  onExit?: (code: number) => void
  onWriteUnavailable?: () => void
  onRecoveryStateChange?: (state: PtyTransportRecoveryState) => void
  onOutputPauseChanged?: (paused: boolean, supported: boolean) => void
}

export type PtyTransportRecoveryState = {
  phase:
    | 'connecting'
    | 'connected'
    | 'recovering'
    | 'backoff'
    | 'disconnected'
    | 'offline'
    | 'ended'
    | 'disposed'
  epoch: number
  attempt: number
}

export type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    sessionId?: string
    /** Hidden-at-spawn declaration (terminal-query-authority.md): no visible
     *  view will consume this PTY's bytes, so main marks it hidden BEFORE the
     *  first byte and the gate + model responder own spawn-time queries.
     *  Ignored by remote-runtime transports (not gate-markable). */
    initiallyHidden?: boolean
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    /** Reject a stale restored identity before this transport can publish global PTY handlers. */
    admitPtyId?: (ptyId: string) => boolean
    /** Reject a stale pane after any pre-spawn test gate but before creating a PTY. */
    shouldContinue?: () => boolean
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
  // Why: latency-critical terminal query replies (CPR/DSR/DA/OSC color/pixel
  // size) must skip input coalescing — a querying program reads them in raw
  // mode with a short timeout, so a debounced reply lands on the shell prompt
  // and corrupts input (#7329). Local transports already write promptly, so
  // this is `sendInput` for them; the remote transport flushes pending input
  // (preserving order) and sends the reply immediately.
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted?: (data: string) => Promise<boolean>
  /** Settles retained pre-connect input when a deferred spawn is abandoned before connect. */
  abandonPreconnectInput?: () => void
  claimViewport?: (cols: number, rows: number) => boolean
  /** Capability-negotiated paired-runtime delivery gate; false preserves legacy delivery. */
  setOutputPaused?: (paused: boolean) => boolean
  resize: (
    cols: number,
    rows: number,
    meta?: {
      widthPx?: number
      heightPx?: number
      cellW?: number
      cellH?: number
      claim?: boolean
    }
  ) => boolean
  isConnected: () => boolean
  getRecoveryState?: () => PtyTransportRecoveryState
  /** Starts a fresh connection epoch while preserving the authoritative remote PTY identity. */
  retryRecovery?: () => boolean
  /** The user dismissed the error surface; the next occurrence of the same message must surface again. */
  notifyErrorSurfaceDismissed?: () => void
  getPtyId: () => string | null
  getConnectionId?: () => string | null | undefined
  /** The runtime captured by this transport; legacy remote PTY ids do not
   * encode their owner, and current worktree settings may have changed. */
  getRuntimeEnvironmentId?: () => string | null
  /** Execution host captured at spawn; nested SSH differs from its outer runtime owner. */
  getExecutionHostId?: () => ExecutionHostId | null
  /** Host platform captured by the PTY owner; paired-client OS is not authoritative. */
  getRemotePlatform?: () => NodeJS.Platform | null
  getLocalSessionMetadata?: () => LocalPtySessionMetadata | null
  /** Drop cross-chunk parser carries (partial OSC-9999 prefix). Called when a
   *  model-restore marker reports dropped bytes — a carry spanning the gap
   *  would corrupt the next live chunk. IPC transports only. */
  resetCrossChunkParserState?: () => void
  serializeBuffer?: (opts?: { scrollbackRows?: number }) => Promise<PtyBufferSnapshot | null>
  serializeBufferOutcome?: (opts?: {
    scrollbackRows?: number
  }) => Promise<RemoteRuntimeSnapshotOutcome>
  preserve?: () => void
  /** Hand the live PTY to a successor without process teardown. Terminal for this instance:
   *  it also drops the transport's output processor from the pty side-effect memory census,
   *  so a reattached one would run untracked. Create a new transport instead. */
  detach?: (options?: { preserveExitObserver?: boolean }) => void
  destroy?: () => void | Promise<void>
}

export type IpcPtyTransportOptions = {
  cwd?: string
  /** Retain bounded user input while a visible split waits to start its PTY. */
  bufferInputUntilConnect?: boolean
  /** Seed a fresh transport with input handed off from a remounted deferred split. */
  preconnectInput?: readonly PtyPreconnectInputEntry[]
  /** Records newly retained input against a remount-safe deferred split handoff. */
  onPreconnectInput?: (input: PtyPreconnectInputEntry) => void
  cwdFallback?: 'worktree'
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  agentPrompt?: string
  agentPromptDelivery?: AgentPromptDelivery
  agentArgsOverride?: string | null
  agentLaunchPreferences?: AgentLaunchPreferences
  launchToken?: string
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  worktreeId?: string
  tabId?: string
  leafId?: string
  activate?: boolean
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  telemetry?: EventProps<'agent_started'>
  onPtyExit?: (ptyId: string, exitCode?: number) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  /** Rebind an existing pane after its provider replaces the PTY identity. */
  onPtyRebind?: (ptyId: string, replacedPtyId: string, incarnationId?: string | null) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}
