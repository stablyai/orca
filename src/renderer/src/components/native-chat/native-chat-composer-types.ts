import type { NativeChatQueueResume } from './native-chat-composer-primary-action'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
import type { StructuredAgentContextUsage } from '../../../../shared/structured-agent-session-context-usage'
import type { AgentSessionSlashCommand } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  StructuredAgentSessionCommandOutcome,
  StructuredAgentSessionCommandRefusalCause
} from '../../../../shared/structured-agent-session-composer'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatAfterStopSend } from './native-chat-composer-target'
import type { NativeChatLocalCommandAnswer } from './use-native-chat-local-command-answer'
import type { NativeChatRecallSource } from './native-chat-sent-prompt-history'

export type NativeChatComposerErrorDetail = {
  /** Error text Orca did not write, shown apart and copyable. */
  errorText?: string
  /** A refused command's cause: its line is said only while that still holds. */
  refusedWhile?: StructuredAgentSessionCommandRefusalCause
}

export type NativeChatOptionPickerRequest = {
  id: string
  sequence: number
}

/** A queue the host holds, with cards waiting. */
export type NativeChatQueueHold = {
  /** Every card shown, held or not. */
  count: number
  /** Delete every card; false when one could not be (already reported). */
  clear: () => Promise<boolean>
}

export type NativeChatStructuredComposerTransport = {
  conversationCommands?: readonly AgentSessionConversationCommand[]
  send: (
    text: string,
    attachments: readonly NativeChatComposerImageAttachment[]
  ) => boolean | 'queued'
  /** A send is out: Send stays disabled, and a send returns false, until it settles. */
  sendOut?: boolean
  dispatchCommand: (text: string) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  /** The `/` surface the running session reports. Absent keeps the curated
   *  per-agent catalog, which is what an older host leaves the client with. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  /** False when the agent takes no image input, as its host registered it. */
  acceptsImages?: boolean
  /** The session's context usage; null until the journal can state it. */
  contextUsage?: StructuredAgentContextUsage | null
  worktreeId?: string
  /** Present only where the host can set this session's goal. */
  threadGoal?: { setObjective: (objective: string) => Promise<boolean> }
  onError: (message: string | null, detail?: NativeChatComposerErrorDetail) => void
  /** A local send: brings the latest into view at the press, not when the host answers. */
  onSubmitted?: () => void
  runtime: 'local' | 'remote'
  /** The session behind this composer; a real user send relinquishes orchestration ownership. */
  sessionId: string
  /** Owning runtime for that report; null is the local runtime. */
  runtimeEnvironmentId: string | null
  /** Present while the queue is held: a message sent now first asks whether to clear its cards. */
  queueHold?: NativeChatQueueHold
  /** Present while the host holds the queue and no turn runs: an empty composer's primary
   *  action becomes Resume, which releases it. */
  queueResume?: NativeChatQueueResume
}

export type NativeChatOptimisticSendOutcome = {
  /** The host refused the write: mark the echo "Message not sent". */
  reject: (pendingId: string) => void
  /** The write acknowledgment was lost: hold the echo, then flag it unconfirmed. */
  holdUnconfirmed: (pendingId: string) => void
}

export type NativeChatComposerProps = {
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Owner of the unsent draft; defaults to `paneKey`. A structured chat's is its conversation,
   *  shared by every composer showing it. */
  draftScopeKey?: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop sends while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** The chat reads Stopping: the placeholder says a message runs after the stop, queued as a
   *  card where the host holds sends as cards (`queue`), else sent and held by the host (`send`). */
  afterStop?: NativeChatAfterStopSend
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Settle an optimistic echo whose write was refused or never acknowledged. */
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** A prompt card owns the input region; the composer stays mounted but hidden. */
  inputOwnedByCard?: boolean
  /** Record a dispatched slash command that does not create a chat turn; `output`
   *  carries the host's answer when the agent never saw the command. */
  onSlashCommand?: (command: string, output?: string) => void
  /** The host's own answer to a command the agent must not see, or null to send it. */
  answerCommandLocally?: NativeChatLocalCommandAnswer
  /** Anything sent to the terminal: a message, a command or a session option. */
  onSubmitted?: () => void
  /** Picker-only agent commands continue in the hosted TUI after dispatch. */
  onSwitchToTerminal?: () => void
  /** Reads the hosted TUI's current rendered screen when chat is entered. */
  readTerminalScreen?: () => string | null
  /** The tab's launch seed as this pane sees it. */
  launchSeed?: NativeChatLaunchSeed
  /** Structured journal transport; absent keeps the existing PTY path unchanged. */
  structuredTransport?: NativeChatStructuredComposerTransport
  /** Cmd/Ctrl+Enter from an empty composer: send the newest queued draft now.
   *  False = nothing queued, and the chord falls through to a plain send. */
  steerQueued?: () => boolean
  /** The chat's own notices, shown in the composer's notice card above its input. */
  notices?: readonly NativeChatComposerNotice[]
  /** The conversation Up/Down recalls prompts from. */
  recallSource?: NativeChatRecallSource
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
  /** Whether the input is there and enabled, so text given to it lands. */
  acceptsText: () => boolean
  /** Adds text after the draft, a blank line apart, and leaves the caret at its end. Text the
   *  draft already ends with is not added again. */
  appendText: (text: string) => void
  /** Routes pane-level paste events back to the composer field. */
  handlePasteEvent: (event: {
    clipboardData: DataTransfer | null
    preventDefault: () => void
    defaultPrevented: boolean
  }) => void
  /** Pastes clipboard content when no DOM paste event is available. */
  pasteFromClipboard: () => void
  /** Whether a node is inside the composer's own input, not merely the chat pane. */
  contains: (node: Node | null) => boolean
}
