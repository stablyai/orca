import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'
import {
  isStructuredAgentSessionHostCommand,
  structuredAgentSessionCommandChangesConversation
} from '../../../../shared/agent-session/view/structured-agent-session-composer'

export type NativeChatComposerSendState = {
  /** Why Send is disabled, when the user can do something about it. */
  sendBlockedReason: string | null
  /** Nothing may be sent yet: an upload, a paste being saved, or the host holds it. */
  sendHeld: boolean
  /** The draft holds text or images: while the agent works, Send takes Stop's place. */
  hasDraft: boolean
  sendButtonDisabled: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend: NativeChatFollowUpBehavior | undefined
  /** Cmd/Ctrl+Enter on an empty composer sends the last queued card now: into the running turn, or with none running (a paused queue after Stop), as its own. */
  chordSteersQueued: boolean
}

/** What the composer's Send/Stop button offers now, and whether it can be pressed. */
export function nativeChatComposerSendState(input: {
  draft: string
  messageDelivery: boolean
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  pastedTextSaving: boolean
  disabled: boolean
  structuredTransport:
    | Pick<
        NativeChatStructuredComposerTransport,
        'sendOut' | 'sendBlockedReason' | 'threadGoal' | 'sendFollowUp'
      >
    | undefined
  editSession: { canSave: boolean } | undefined
  isWorking: boolean
  canStop: boolean
  /** The draft is an Orca command such as /resume, which runs without the agent. */
  orcaCommand?: boolean
  /** Goal mode submits the draft as an objective, which starts work. */
  goalMode?: boolean
}): NativeChatComposerSendState {
  const { structuredTransport: transport } = input
  const imageBlock = nativeChatImageSendBlock(input.imageAttachments)
  const localHold =
    input.pastedTextSaving || input.disabled || transport?.sendOut === true || imageBlock.holdsSend
  const hostHold = transport?.sendBlockedReason !== undefined
  const sendHeld = localHold || hostHold
  // Like Enter, a held host still takes commands that start no turn.
  const runsWhileHostHolds =
    input.orcaCommand === true ||
    (transport !== undefined &&
      input.goalMode !== true &&
      input.imageAttachments.length === 0 &&
      isStructuredAgentSessionHostCommand(input.draft, transport.threadGoal !== undefined) &&
      !structuredAgentSessionCommandChangesConversation(input.draft))
  const draftHeld = localHold || (hostHold && !runsWhileHostHolds)
  const hasDraft = input.draft.trim() !== '' || input.imageAttachments.length > 0
  // Like Enter, a typed draft sends while the agent works; only an empty one offers Stop.
  const sendButtonDisabled = input.editSession
    ? sendHeld || !input.editSession.canSave
    : input.isWorking && !hasDraft
      ? !input.canStop
      : draftHeld || !hasDraft
  // The send's own resolver, so the hint withdraws wherever Cmd/Ctrl+Enter would send no differently.
  const followUp = transport?.sendFollowUp
  const alternateSend: NativeChatFollowUpBehavior | undefined =
    input.messageDelivery && !input.editSession && followUp?.offersChoice
      ? followUp.action === 'queue'
        ? 'steer'
        : 'queue'
      : undefined
  return {
    // The host's reason labels Send only while it holds this draft.
    sendBlockedReason:
      imageBlock.reason ??
      (hostHold && !runsWhileHostHolds ? transport?.sendBlockedReason : null) ??
      null,
    sendHeld,
    hasDraft,
    sendButtonDisabled,
    alternateSend,
    // Never where the chord queues, or a second press would steer the card the first one just queued.
    chordSteersQueued:
      input.messageDelivery && !input.editSession && (alternateSend === 'steer' || !input.isWorking)
  }
}
