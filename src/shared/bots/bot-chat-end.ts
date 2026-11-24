// Ending one of a bot's side chats: `bots.endChat`'s params and answer, shared by the desktop, the CLI
// and any paired client. An ended chat leaves its tab and the bot's list and takes no new mail or
// turns; reopening it from Session History brings it back.
import { z } from 'zod'

export const BotChatEndParams = z.object({
  /** One per click or command run: a repeat of the same op gets the first answer back. */
  opId: z.string().min(8).max(100),
  /** The id `orca bot chats` prints, with or without `chat:`; any session of its lineage. */
  chat: z.string().min(1).max(200),
  botId: z.string().min(1).optional(),
  callerSessionId: z.string().min(1).optional(),
  /** `x`: the person closed the chat's tab; when it can't end, it goes to the background as before. */
  intent: z.enum(['x', 'end']),
  /** With `x`: the host's name for the tab showing the person closed (the snapshot's `showing`). */
  showing: z.string().min(1).max(200).optional()
})
export type BotChatEndParams = z.infer<typeof BotChatEndParams>

/** Why a chat can't end now; the host decides, clients only word it. */
export type BotChatEndReason =
  | { kind: 'replying' }
  | { kind: 'unread'; count: number }
  | { kind: 'requests'; count: number }
  | { kind: 'questions'; count: number }
  /** Coordinated a Run: never ends in PR 1. */
  | { kind: 'ran-workers' }
  /** Dispatches it created or was given that are not final yet (pending or dispatched). */
  | { kind: 'dispatch'; count: number }
  | { kind: 'automation'; name: string }
  | { kind: 'automation-run' }
  | { kind: 'usage-continue' }
  | { kind: 'restart-offer' }
  | { kind: 'stopping' }
  | { kind: 'reopened' }
  | { kind: 'unreadable' }

/** Chats this op never ends, whatever they owe. */
export type BotChatEndRefusal =
  | { kind: 'home' }
  | { kind: 'self' }
  | { kind: 'other-bot' }
  | { kind: 'outside-turn' }
  | { kind: 'not-owner' }
  | { kind: 'linked'; source: string }
  | { kind: 'not-found' }

export type BotChatEndResult =
  | { outcome: 'ended'; title: string | null }
  | { outcome: 'already-ended' }
  /** `background`: with `x`, the chat went to the background as a closed tab always did. */
  | { outcome: 'kept'; reasons: BotChatEndReason[]; background?: true }
  | { outcome: 'refused'; refusal: BotChatEndRefusal; background?: true }
  /** With `x`: the tab the person closed is no longer the one showing; nothing changed. */
  | { outcome: 'superseded' }
  /** The write's outcome is unknown; the chat takes nothing new until Orca restarts. */
  | { outcome: 'unknown' }

/** Whether a reason can clear by itself (try again later) or never will in this chat. */
export function botChatEndReasonPermanent(reason: BotChatEndReason): boolean {
  return reason.kind === 'ran-workers'
}
