import type { TerminalAttachmentLaunchResult } from '../../../../shared/terminal-attachment-launch-result'
import type { AgentIdleEdgeMeta } from '../../../../shared/terminal-output-side-effects'
import type {
  RestoreSpawnIntent,
  SpawnDeferralReason
} from '../../../../shared/host-spawn-admission'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import type {
  TerminalLaunchResult,
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
import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import type { TerminalOscColorQueryReplyColors } from '../../../../shared/terminal-osc-color-reply'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { TerminalPanePlacement } from '../../../../shared/terminal-pane-placement'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { PtyDataMeta } from './pty-dispatcher'
import type {
  RemoteRuntimeSnapshotOutcome,
  RemoteRuntimeSnapshotRequestOptions
} from '../../runtime/remote-runtime-terminal-multiplexer-types'
import type { AcceptedInputOptions, PtyPreconnectInputEntry } from './pty-preconnect-input-buffer'
import type { AgentPaneLaunchRequest } from '../../../../shared/agent-pane-launch-request'

export type PtyBufferSnapshot = {
  data: string
  /** Live state that can be restored without an alternate-screen frame. */
  frameRestoreAnsi?: string
  cols: number
  rows: number
  seq?: number
  /** Start of main’s pending delivery window; once-only ordered delivery makes earlier post-restore chunks new seq domains rather than snapshot duplicates. */
  pendingDeliveryStartSeq?: number
  source?: 'headless' | 'renderer'
  /** Alternate-screen image: preserve normal scrollback during replay rather than clearing it with the TUI frame. */
  alternateScreen?: boolean
  /** Authoritative normal buffer paired with an alternate-screen frame. */
  scrollbackAnsi?: string
  /** `data` starts on the normal buffer and enters alt itself (remote images fold
   *  their normal buffer in rather than splitting it into `scrollbackAnsi`). */
  carriesNormalBuffer?: boolean
  /** Write incomplete escapes last after reset, before live continuation, so split sequences complete instead of printing literally (#7329). */
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
  /** Owner-proven Kitty flags at snapshotSeq; omission remains unknown rather than known zero. */
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
  /** An image that starts on the normal buffer and enters alt itself; absent for
   *  raw byte replays such as an SSH relay's ring buffer. */
  carriesNormalBuffer?: boolean
  /** The image folds host history above its screen; absent for screen-only images. */
  carriesHistory?: boolean
}

export type LocalPtySessionMetadata = {
  cwd?: string
  shellOverride?: string
}

export type PtyConnectResult = TerminalLaunchResult & {
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
  /** Owner-proven Kitty flags at main’s reconciled renderer snapshotSeq; older-host omission remains unknown. */
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
  /** Main refused the resume and started the plain shell: a native chat is the conversation's home
   *  or may be writing it, or no record could be checked (the saved session is kept to retry). */
  agentResumeRefused?: 'chat-home' | 'chat-writing' | 'unverifiable'
  /** Write daemon’s trailing partial escape after reset so racing live bytes can complete it (#7329). */
  pendingEscapeTailAnsi?: string
}

type PtyCallbacks = {
  onLaunchResult?: (result: TerminalAttachmentLaunchResult) => void
  /** Called before an adopted PTY can publish buffered/live bytes. */
  onReattachDetermined?: () => void
  onConnect?: () => void
  /** Recovered streams contain only new bytes; fetch retained history or idle/exited panes may stay blank. */
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
  /** `dropsReported`: the host sends onPausedOutputDropped, so a pause without one lost nothing. */
  onOutputPauseChanged?: (paused: boolean, supported: boolean, dropsReported?: boolean) => void
  onPausedOutputDropped?: () => void
  /** The host kept this restore asleep; no process started and the resume handle is intact. */
  onSpawnDeferred?: (reason: SpawnDeferralReason) => void
}

/** What started a pane's recovery: the server connection, or only this pane's stream. */
export type PtyRecoveryCause = 'connection' | 'stream-stalled' | 'stream-ended'

export type PtyTransportRecoveryState = {
  reason?: 'ownership' | 'ssh-sign-in'
  cause?: PtyRecoveryCause
  /** A retry is parked for an outside trigger; nothing retries on its own until then. */
  waiting?: true
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
  getPendingEscapeTailAnsi?: () => string
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    sessionId?: string
    /** Declare hidden before spawn bytes so main’s gate/model responder owns queries from byte zero; remote runtimes ignore this local-only field. */
    initiallyHidden?: boolean
    /** Layout-owner build: attach to `sessionId` or start nothing; main starts the pane. */
    attachOnlyView?: true
    /** Sent only when this connect resumes an agent, and only to hosts that accept it. */
    resumeSpawnIntent?: RestoreSpawnIntent
    /** A restore no user act asked for: main holds a stopped WSL distro's pane instead of starting it. */
    wslPassiveRestore?: true
    command?: string
    commandDelivery?: 'renderer' | 'provider'
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    resumeOrigin?: 'saved'
    launchToken?: string
    launchAgent?: TuiAgent
    startupCommandDelivery?: StartupCommandDelivery
    /** Consume only at fresh spawn dispatch; main stops the returned predecessor before resolving ownership. Reattach leaves retirement with the caller. */
    claimReplacedPtyId?: () => string | null
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
  sendInput: (data: string, inputKind: TerminalInputKind) => boolean
  // Send query replies immediately, after flushing earlier input in order; debounce can miss raw-mode reads and leak replies at shell prompts (#7329).
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted?: (
    data: string,
    inputKind: TerminalInputKind,
    options?: AcceptedInputOptions
  ) => Promise<boolean>
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
  /** True while the transport has a retry armed or parked; pane-level remounts must defer to it. */
  ownsRecovery?: () => boolean
  /** Typed input the host has not applied yet, which a remount would discard. */
  hasUndeliveredInput?: () => boolean
  /** The user dismissed the error surface; the next occurrence of the same message must surface again. */
  notifyErrorSurfaceDismissed?: () => void
  getPtyId: () => string | null
  /** A connect (spawn or reattach) is still awaiting its PTY id. */
  isConnectPending?: () => boolean
  getConnectionId?: () => string | null | undefined
  /** The runtime captured by this transport; legacy remote PTY ids do not
   * encode their owner, and current worktree settings may have changed. */
  getRuntimeEnvironmentId?: () => string | null
  /** Execution host captured at spawn; nested SSH differs from its outer runtime owner. */
  getExecutionHostId?: () => ExecutionHostId | null
  /** Host platform captured by the PTY owner; paired-client OS is not authoritative. */
  getRemotePlatform?: () => NodeJS.Platform | null
  getLocalSessionMetadata?: () => LocalPtySessionMetadata | null
  /** Drop cross-chunk carry on local-main restore markers; partial OSC state spanning lost bytes would corrupt live output. */
  resetCrossChunkParserState?: () => void
  serializeBuffer?: (
    opts?: RemoteRuntimeSnapshotRequestOptions
  ) => Promise<PtyBufferSnapshot | null>
  serializeBufferOutcome?: (
    opts?: RemoteRuntimeSnapshotRequestOptions
  ) => Promise<RemoteRuntimeSnapshotOutcome>
  preserve?: () => void
  /** Terminal handoff releases this transport’s processor census entry without killing the PTY; successors must create a fresh transport. */
  detach?: (options?: { preserveExitObserver?: boolean }) => void
  destroy?: (options?: {
    /** Explicit close can retain retirement intent until an unbound connect settles. */
    onAbandonedConnect?: (ptyId: string) => boolean
  }) => void | Promise<void>
}

export type IpcPtyTransportOptions = {
  cwd?: string
  /** Retain bounded user input until the pane's first PTY connection binds. */
  bufferInputUntilConnect?: boolean
  /** A new pane with no old screen: typing before its first remote terminal exists goes to it. */
  /** 'connect' decides once that the pane looked blank; 'bind' re-checks only what a create can't cause. */
  keepTypeAheadForNewTerminal?: (phase: 'connect' | 'bind') => boolean
  /** Re-checked when held input would flush; false drops it (startup work appeared after the hold began). */
  releasePreconnectInput?: () => boolean
  /** Keys typed before a remote pane bound its terminal were dropped for safety, unsent. */
  onTypingDiscardedBeforeBind?: () => void
  /** Seed a fresh transport with input handed off from a remounted deferred split. */
  preconnectInput?: readonly PtyPreconnectInputEntry[]
  /** Records newly retained input against a remount-safe deferred split handoff. */
  onPreconnectInput?: (input: PtyPreconnectInputEntry) => void
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  commandDelivery?: 'renderer' | 'provider'
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  resumeOrigin?: 'saved'
  agentPrompt?: string
  agentPromptDelivery?: AgentPromptDelivery
  agentArgsOverride?: string | null
  agentLaunchPreferences?: AgentLaunchPreferences
  launchToken?: string
  launchAgent?: TuiAgent
  agentLaunch?: AgentPaneLaunchRequest
  startupCommandDelivery?: StartupCommandDelivery
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  worktreeId?: string
  tabId?: string
  leafId?: string
  /** Sent on fresh spawns only; a reattach names a PTY whose leaf main already knows. */
  placement?: TerminalPanePlacement
  activate?: boolean
  shellOverride?: string
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalKittyKeyboardProtocol?: boolean
  terminalColorQueryReplies?: TerminalOscColorQueryReplyColors
  telemetry?: EventProps<'agent_started'>
  onPtyExit?: (ptyId: string, exitCode?: number) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  /** Current surface may retain a late disposed spawn for its successor; absent/false authorizes kill (disposed-spawn-retention.ts). */
  retainDisposedSpawn?: () => boolean
  /** Rebind an existing pane after its provider replaces the PTY identity. */
  onPtyRebind?: (ptyId: string, replacedPtyId: string, incarnationId?: string | null) => void
  /** The host bound a new live process to a pane this transport already ended on its exit record. */
  onHostReboundExitedPty?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string, meta?: AgentIdleEdgeMeta) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}
