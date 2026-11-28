// A new bot's Chat from Orca's kickoff: its first screen, Stop's hold, and sends on the owner's behalf.
import { createContext, useLayoutEffect, useMemo, useRef } from 'react'
import type { Bot } from '../../../../shared/bot-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useBotForWorkspace } from '../bots/bot-workspace'
import {
  nativeChatFirstScreen,
  nativeChatKickoffEnded,
  nativeChatKickoffRefusal,
  type KickoffSession,
  type NativeChatFirstScreen
} from '../../../../shared/bots/bot-first-screen'
import type { NativeChatStructuredComposerTransport } from './composer/submit/native-chat-structured-composer-transport'
import { projectionBesideStreamedText } from '../../../../shared/agent-session/view/structured-agent-session-streamed-text-rows'

export type NativeChatBotKickoffView = {
  /** The owner hasn't written since the latest kickoff. */
  live: boolean
  /** Sends as the owner; resolves false when the chat refused it. */
  send: (text: string) => Promise<boolean>
  /** Why the chat holds sends now, if it does. */
  sendBlockedReason: () => string | undefined
  /** The bot whose Chat it is. */
  bot: Bot | null
  /** This chat's session, on the host that runs it. */
  sessionId: string | null
  /** A new bot's first turn until it has spoken, which its Home shows as its first screen. */
  firstScreen: NativeChatFirstScreen | null
  /** Orca's first kickoff, where the bot's header sits; a Try again sends later ones. */
  firstKickoffId: string | null
}

export const NativeChatBotKickoffContext = createContext<NativeChatBotKickoffView | null>(null)

function nativeChatKickoffLive(messages: readonly NativeChatMessage[]): boolean {
  const kickoff = messages.findLastIndex((message) => message.orcaNotice === 'bot-created')
  return kickoff !== -1 && !messages.slice(kickoff + 1).some((message) => message.role === 'user')
}

export function useNativeChatBotKickoffView(
  messages: readonly NativeChatMessage[],
  session: KickoffSession,
  transport: NativeChatStructuredComposerTransport,
  workspaceId: string | null,
  sessionId: string | null
): NativeChatBotKickoffView {
  const bot = useBotForWorkspace(workspaceId)
  const latestTransport = useRef(transport)
  useLayoutEffect(() => {
    latestTransport.current = transport
  }, [transport])
  // Kickoffs and sends are structure, so a streamed reply's text revision keeps these lookups.
  const structure = projectionBesideStreamedText(messages)
  const live = useMemo(() => bot !== null && nativeChatKickoffLive(structure), [bot, structure])
  const turnEnded = nativeChatKickoffEnded(session)
  const refusal = nativeChatKickoffRefusal(session)
  // Keyed by its words, so a new object for the same refusal keeps the first screen.
  const refusedReason = refusal?.reason ?? null
  const refusedDetail = refusal?.providerDetail
  const refusedKind = refusal?.kind
  const refusedSignedOut = refusal?.notSignedIn !== undefined
  const refusedAccount = refusal?.notSignedIn?.account
  const firstScreen = useMemo(
    () =>
      live
        ? nativeChatFirstScreen(
            messages,
            turnEnded,
            refusedReason === null
              ? null
              : {
                  reason: refusedReason,
                  ...(refusedDetail ? { providerDetail: refusedDetail } : {}),
                  ...(refusedKind ? { kind: refusedKind } : {}),
                  // The setup card offers this sign-in.
                  ...(refusedSignedOut
                    ? { notSignedIn: refusedAccount ? { account: refusedAccount } : {} }
                    : {})
                }
          )
        : null,
    [
      live,
      messages,
      turnEnded,
      refusedReason,
      refusedDetail,
      refusedKind,
      refusedSignedOut,
      refusedAccount
    ]
  )
  const firstKickoffId = useMemo(
    () =>
      bot === null
        ? null
        : (structure.find((message) => message.orcaNotice === 'bot-created')?.id ?? null),
    [bot, structure]
  )
  return useMemo(
    () => ({
      live,
      bot,
      sessionId,
      firstScreen,
      firstKickoffId,
      send: (text) =>
        Promise.resolve()
          .then(() => latestTransport.current.send(text, []))
          .then(
            (sent) => sent !== false,
            () => false
          ),
      sendBlockedReason: () => latestTransport.current.sendBlockedReason
    }),
    [live, bot, sessionId, firstScreen, firstKickoffId]
  )
}
