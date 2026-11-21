import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { NativeChatAfterStopSend } from './submit/native-chat-composer-target'
import type { NativeChatOptimisticSendOutcome } from '../session/terminal/delivery/native-chat-optimistic-send-outcome'
import type { NativeChatLocalCommandAnswer } from '../session/options/terminal/use-native-chat-local-command-answer'
import type { NativeChatLaunchSeed } from '../drafts/native-chat-launch-seed'
import type { NativeChatStructuredComposerTransport } from './submit/native-chat-structured-composer-transport'
import type { NativeChatComposerNotice } from './controls/native-chat-composer-notice'
import type { NativeChatRecallSource } from '../drafts/native-chat-sent-prompt-history'
import type { OrchestrationAgentReference } from '../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'

/** A room target `@` lists, e.g. a bot group's member or another bot from a bot's chat. */
export type NativeChatRoomMention = {
  name: string
  /** Its value in the `@` menu where names can repeat (bots on two computers); its name when absent. */
  key?: string
  /** The bot it is, where its chats can be opened from its row. */
  id?: string
  icon: React.ReactNode
  /** A second line, such as what a bot is for; `@` matches it too. */
  detail?: string
  /** A second line shown as written, in place of "For: …" (the chat's own bot: "Your other chats"). */
  note?: string
  /** Shown before the note, such as an agent's status. */
  noteIcon?: React.ReactNode
  /** Shown but not pickable, with this tag (a paused bot). */
  unavailable?: string
  /** The computer it runs on, as a pill on its second line, for a bot on another computer. */
  host?: React.ReactNode
  /** Shown dimmed in its place, still pickable: its computer isn't connected now. */
  dimmed?: true
}

/** A multi-agent room: `@` names members, and the reply control reads the draft. A bot's own chat
 *  lists the other bots above files instead. */
/** A member's value in the `@` menu. */
export function nativeChatMentionValue(mention: NativeChatRoomMention): string {
  return mention.key ?? mention.name
}

export type NativeChatComposerRoom = {
  replies?: (draft: string) => React.ReactNode
  mentions: readonly NativeChatRoomMention[]
  placeholder: string
  withFiles?: true
}

export type NativeChatComposerProps = {
  room?: NativeChatComposerRoom
  /** Tab hosting the agent; used to resolve the live ptyId + runtime settings. */
  terminalTabId: string
  /** Input-only edit session: every submit saves, Escape cancels, and send-only actions are absent. */
  editSession?: { save: () => void; cancel: () => void; canSave: boolean }
  /** Stable split-leaf identity; unlike a PTY id, this survives reconnects. */
  paneKey: string
  /** Unsent-draft owner; defaults to paneKey, while structured chats share conversation scope. */
  draftScopeKey?: string
  /** Specific split-pane PTY this chat view owns. */
  targetPtyId: string | null
  agent: AgentType
  /** Guard desktop sends while a mobile client owns the terminal input lease. */
  canSend?: boolean
  /** Disable unavailable input and show this reason as its placeholder. */
  unavailableHint?: string | undefined
  /** True while the hosted TUI reports an in-flight turn; swaps Send to Stop. */
  isWorking?: boolean
  /** This client's Stop request is in flight: the Stop control is disabled and says so. */
  isStopping?: boolean
  /** While Stopping, queue a card or send for the host to hold until settlement. */
  afterStop?: NativeChatAfterStopSend
  /** Interrupt the hosted agent, usually by sending ESC into the PTY. */
  onStop?: () => void
  /** False while Escape must not stop the turn, e.g. a new bot's first turn: only the Stop button does. */
  escapeStops?: boolean
  /** Render an optimistic echo until the real transcript turn lands. */
  onOptimisticSend?: (text: string, imagePaths?: string[]) => string | undefined
  /** Settle an optimistic echo whose write was refused or never acknowledged. */
  optimisticSendOutcome?: NativeChatOptimisticSendOutcome
  /** Remove an optimistic echo when its delayed submit is canceled. */
  onOptimisticSendCanceled?: (pendingId: string) => void
  /** A prompt card owns the input region; the composer stays mounted but hidden. */
  inputOwnedByCard?: boolean
  /** Record non-turn commands; output holds the host’s response when the agent never saw it. */
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
  /** Current terminal conversation, after local /clear boundaries. */
  contextMessages?: readonly NativeChatMessage[]
  /** Compose against the source checkout until the new workspace and session exist. */
  workspacePending?: true
  /** The first prompt in an agent's launch panel: one line that grows, Attach as its only control,
   *  no /resume, the launch workspace's skills, and a draft kept in memory until the launch. */
  launchPrompt?: { placeholder: string; onEmptySubmit: () => void }
  /** Cmd/Ctrl+Shift+Enter steers the head queued card; false when it can't. */
  steerHead?: () => boolean
  /** The chat's own notices, shown in the composer's notice card above its input. */
  notices?: readonly NativeChatComposerNotice[]
  /** The conversation Up/Down recalls prompts from. */
  recallSource?: NativeChatRecallSource
}

export type NativeChatComposerHandle = {
  resend?: (text: string, imagePaths?: string[]) => boolean
  insertAgentReferences: (references: OrchestrationAgentReference[]) => boolean
  isComposing?: () => boolean
  /** `caretAtEnd` puts the caret after text already in the box; `glow` flashes the box once. */
  focus: (options?: { caretAtEnd?: boolean; glow?: boolean }) => boolean
  /** Dictated text is spaced from the text around the caret. */
  insertTypedText: (text: string, options?: { dictated?: boolean }) => boolean
  insertPastedText?: (text: string) => boolean
  /** Whether the input is there and enabled, so text given to it lands. */
  acceptsText: () => boolean
  /** Append text after a blank line and place the caret at its end; repeated additions stay separate; `glow` flashes the box once. */
  appendText: (text: string, options?: { glow?: boolean }) => void
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
  /** Sends the draft as Enter would, for a send control outside the composer. */
  submit?: () => void
}
