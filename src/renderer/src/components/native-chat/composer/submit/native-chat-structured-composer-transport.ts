import type { CaptureStructuredAgentSessionPresentation } from '../../session/structured/writes/use-structured-agent-session-mutate'
import type { AgentSessionConversationCommand } from '../../../../../../shared/agent-session/agent-session-conversation-command'
import type { NativeChatComposerImageAttachment } from '../../attachments/chips/native-chat-image-attachment'
import type { StructuredAgentSessionSendRequest } from '../../session/structured/delivery/structured-agent-session-send-slot'
import type { NativeChatSendFollowUp } from '../../../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { StructuredAgentSessionCommandOutcome } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import type {
  SessionOptionsSurface,
  SessionOptionDescriptor
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatOptionPickerRequest } from '../../session/options/controls/native-chat-option-picker-request'
import type { AgentSessionSlashCommand } from '../../../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentContextUsage } from '../../../../../../shared/agent-session/structured-agent-session-context-usage'
import type { NativeChatComposerErrorDetail } from '../controls/native-chat-composer-error-detail'
import type { NativeChatSideChat } from '../../messages/actions/use-native-chat-side-chat'

export type NativeChatStructuredComposerTransport = {
  capturePresentation: CaptureStructuredAgentSessionPresentation
  conversationCommands?: readonly AgentSessionConversationCommand[]
  compactInstructions?: boolean
  send: (
    text: string,
    attachments: readonly NativeChatComposerImageAttachment[],
    request?: StructuredAgentSessionSendRequest
  ) => boolean | 'queued' | Promise<boolean>
  /** A send is out: Send stays disabled, and a send returns false, until it settles. */
  sendOut?: boolean
  /** Send is held for this reason, which the disabled button says. */
  sendBlockedReason?: string
  /** What a plain send does now, and whether Cmd/Ctrl+Enter would send it the other way. */
  sendFollowUp?: NativeChatSendFollowUp
  /** `onSent` fires once a conversation command leaves for the host, before its reply. */
  dispatchCommand: (
    text: string,
    onSent?: () => void
  ) => Promise<StructuredAgentSessionCommandOutcome>
  optionsSurface: SessionOptionsSurface
  optionSnapshot: SessionOptionDescriptor[]
  optionPickerRequest?: NativeChatOptionPickerRequest | null
  /** Use host-reported slash commands, falling back to curated catalogs for older hosts. */
  sessionCommands?: readonly AgentSessionSlashCommand[]
  /** Request command refresh; updated choices arrive through sessionCommands. */
  refreshCommands?: () => void
  setCommandsMenuOpen?: (open: boolean) => void
  /** The open menu's host read is in flight; an empty filter may still fill in. */
  commandsChecking?: boolean
  /** False when the agent takes no image input, as its host registered it. */
  acceptsImages?: boolean
  /** The session's context usage; null until the journal can state it. */
  contextUsage?: StructuredAgentContextUsage | null
  worktreeId?: string
  tabId?: string
  /** Present only where the host can set this session's goal. */
  threadGoal?: { setObjective: (objective: string) => Promise<boolean> }
  /** `/btw`; absent where Orca can't fork this chat, so the command stays the agent's. */
  sideChat?: NativeChatSideChat
  /** Present only where the host can read this chat's Codex account usage. */
  accountUsage?: { open: () => void }
  /** Present only where this chat can fork; `run` answers with a notice when it didn't fork. */
  fork?: { run: () => string | null }
  onError: (message: string | null, detail?: NativeChatComposerErrorDetail) => void
  /** A local send: brings the latest into view at the press, not when the host answers. */
  onSubmitted?: () => void
  /** At the press, the reveal to run once the host admits the message. */
  captureAdmittedReveal?: () => () => void
  runtime: 'local' | 'remote'
  /** The session behind this composer; a real user send relinquishes orchestration ownership. */
  sessionId: string
  attachmentStagingScope?: string
  /** Owning runtime for that report; null is the local runtime. */
  runtimeEnvironmentId: string | null
  /** The host has not confirmed this chat: session uploads wait for publication. */
  sessionPending?: boolean
  sessionPendingNotice?: string
}
