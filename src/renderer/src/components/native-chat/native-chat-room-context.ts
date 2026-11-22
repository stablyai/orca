import { createContext, type ReactNode } from 'react'
import type { NativeChatRoomMemberMatch } from '../../../../shared/native-chat/input/native-chat-room-mentions'
import type { NativeChatComposerRoom } from './composer/native-chat-composer-types'
import type { NativeChatBotChatPicker } from './native-chat-mention-chats'
import type { NativeChatMentionChatDrill } from './composer/pickers/use-native-chat-mention-chat-drill'

/** The composer's room, if any: its reply control for this draft, its `@` members, and the matching
 *  members `@` shows but can't pick. */
export const NativeChatRoomContext = createContext<{
  replies: ReactNode
  mentions: NativeChatComposerRoom['mentions']
  withFiles: boolean
  unavailable: readonly string[]
  /** This chat's crew agents, listed above the bots; their values lead the `@` list. */
  agents?: NativeChatComposerRoom['mentions']
  /** A bot's chats one level under its row; absent where none can be picked. */
  chats?: { picker: NativeChatBotChatPicker; drill: NativeChatMentionChatDrill }
  /** How each listed member matched the query, for bolding its hits. */
  matches?: readonly NativeChatRoomMemberMatch[]
  /** Leading rows bare `@` lists under "Recent". */
  recentCount?: number
  query?: string
} | null>(null)

/** The owner's bots a chat's composers list under `@`; `token` is what picking one puts in the
 *  draft, `@name` when absent; `opened` runs when `@` opens, to read what each is for. */
export type NativeChatBotChatRoom = NativeChatComposerRoom & {
  /** What picking the member with this `@` menu value puts in the draft. */
  token?: (value: string) => string | undefined
  opened?: () => void
}

/** A bot a draft names, as the chat can reach it now: its current name, its picture sized for a
 *  pill, and whether it is paused. */
export type NativeChatBotMentionTarget = { name: string; avatar: ReactNode; paused: boolean }

/** Looks a picked bot up by id, on the paired server `server` names if any: null once its computer
 *  has listed its bots without it (deleted), undefined while that isn't known (not listed yet, or no
 *  bots here). */
export const NativeChatBotMentionTargetContext = createContext<
  (id: string, server?: string) => NativeChatBotMentionTarget | null | undefined
>(() => undefined)

export const NativeChatBotChatRoomContext = createContext<NativeChatBotChatRoom | undefined>(
  undefined
)

/** The chat's bots' chats: what the `@` list opens under a bot, and how a picked chat reads. Set
 *  wherever the chat's bots are known, a group room's too, so a pasted chat pill says why it can't go. */
export const NativeChatBotChatPickerContext = createContext<NativeChatBotChatPicker | undefined>(
  undefined
)

/** Which bot pill's chat list is open, by the pill's place among the draft's bot pills. */
export const NativeChatBotChatChooserContext = createContext<{
  at: number | null
  open: (index: number) => void
  close: () => void
} | null>(null)
