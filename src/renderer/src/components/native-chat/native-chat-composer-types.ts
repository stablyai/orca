import type { AgentType } from '../../../../shared/agent-status-types'
import type { StructuredAgentSessionCommandOutcome } from '../../../../shared/structured-agent-session-composer'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type {
  OmpRpcChatSendBehavior,
  OmpRpcChatSendResult
} from '../../../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { OmpRpcChatPaneConsumedFailure } from '../../store/slices/omp-rpc-chat-pane-failure-notice'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { OmpRpcExecutableCommands } from './omp-rpc-command-catalog'

export type NativeChatOptionPickerRequest = {
  id: string
  sequence: number
}

export type NativeChatStructuredComposerTransport = {
  send: (text: string, attachments: readonly NativeChatComposerImageAttachment[]) => boolean
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  worktreeId?: string
  onError: (message: string | null) => void
  runtime: 'local' | 'remote'
}
export type NativeChatComposerOmpRpcBinding = {
  isOwned: boolean
  isTurnWorking: boolean
  send: (args: {
    message: string
    behavior: OmpRpcChatSendBehavior
    /** The wire `id` a command send is correlated under, so its later
     *  `prompt_result` frame can be attributed to that run alone. */
    requestId?: string
    /** The generation the send was dispatched on, checked against the live
     *  session so a queued command cannot land in one that replaced it. */
    expectedGeneration?: number
    /** Run only once the transport's own gates admit the send. */
    onAuthorized?: () => void
  }) => Promise<OmpRpcChatSendResult>
  /** Retires the previous slash command's captured output before the next
   *  one's frames arrive, under the id correlating that run. Absent for a pane
   *  with no RPC session. */
  onCommandDispatched?: (commandRunId: string) => void
  /** Suppresses that captured output once the command's own response reports
   *  it started an agent turn, unless a later run already owns the slot. */
  onCommandAgentInvoked?: (commandRunId: string) => void
  /** Pane-owned failure feedback for a command whose dispatch outlived the
   *  composing surface. Read and cleared by whichever composer remounts. */
  commandFailureMessage?: string | null
  /** That notice describes an already-replaced session, so it yields to a live
   *  one this composer is showing rather than relabelling it. */
  commandFailureSuperseded?: boolean
  /** Distinguishes one notice occurrence from the next, including a repeat
   *  failure whose wording is identical. */
  commandFailureId?: number | null
  clearCommandFailure?: (consumed: OmpRpcChatPaneConsumedFailure) => void
  reportCommandFailure?: (command: string, expectedGeneration?: number) => void
  /** Same, for an ordinary message whose send outlived the composer. */
  reportMessageFailure?: (expectedGeneration: number) => void
  /** What the owning session will actually dispatch, from OMP's published RPC
   *  catalog. Null while no catalog has arrived, which is not permission to
   *  send — the session route needs positive proof. */
  executableCommands?: OmpRpcExecutableCommands | null
  /** The owning session's published catalog, which outranks the cwd-cached
   *  probe snapshot for the `/` menu (see `selectOmpRpcLiveCommands`). */
  commands?: readonly OmpRpcSlashCommand[] | null
  /** Identifies the RPC session bound to the pane, so a completion that
   *  outlives a rebind can be discarded. */
  sessionGeneration?: number
  /** Stable pane-plus-generation identity for the RPC command queue. */
  commandQueueKey?: string
}

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop sends while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** Record a dispatched slash command that does not create a chat turn. */
  onSlashCommand?: (command: string) => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Reads the hosted TUI's current rendered screen when chat is entered. */
  readTerminalScreen?: () => string | null
  /** The tab's launch seed as this pane sees it. */
  launchSeed?: NativeChatLaunchSeed
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Session-scoped OMP RPC transport; absent keeps the PTY path unchanged. */
  ompRpcChat?: NativeChatComposerOmpRpcBinding
}

/** Launch context prefilled into the TUI input as an unsent draft, plus the two
 *  facts that decide its fate in this pane's composer. */
export type NativeChatLaunchSeed = {
  launchDraft: NativeChatLaunchDraft | null
  /** True once the transcript shows the TUI-side draft was submitted or cleared. */
  launchDraftResolved: boolean
  /** False for every pane of a split tab; gates adopting the seed, not cleanup. */
  ownsTabWideLaunchDraft: boolean
}

export type NativeChatComposerHandle = {
  focus: () => boolean
  insertTypedText: (text: string) => boolean
  /** Routes pane-level paste events back to the composer field. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Pastes clipboard content when no DOM paste event is available. */
  pasteFromClipboard: () => void
}
