// A bot chat's countdown as its host keeps it, and this window's hold on it: while the chat is in front
// of a focused window, or has an unsent message here, the host pauses it; the hold lapses on its own.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { callBotRpc } from '@/lib/bot-hosts'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import type { Bot } from '../../../../shared/bot-types'
import {
  botChatAutoCloseHolds,
  readBotChatAutoCloseView,
  type BotChatAutoCloseView
} from '../../../../shared/bots/bot-chat-auto-close'
import {
  readNativeChatComposerDraft,
  subscribeToNativeChatComposerDraft
} from '../native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../native-chat/drafts/native-chat-draft-scope'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'

const RPC_OPTIONS = { suppressFeatureInteraction: true }

/** Well inside the host's 30 s lease. */
const HOLD_RENEW_MS = 10_000

/** Past each whole minute left, so the text has turned over. */
const MINUTE_TURN_SLACK_MS = 50

/** This window, among every desktop holding the same chat. */
const HOLDER = `window:${createNonSecureContextUuid()}`

function subscribeWindowFocus(listener: () => void): () => void {
  window.addEventListener('focus', listener)
  window.addEventListener('blur', listener)
  return () => {
    window.removeEventListener('focus', listener)
    window.removeEventListener('blur', listener)
  }
}

const readWindowFocus = (): boolean => document.hasFocus()

function useHasUnsentMessage(sessionId: string): boolean {
  const scope = structuredAgentSessionDraftScopeKey(sessionId)
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(scope, listener),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => {
    const draft = readNativeChatComposerDraft(scope)
    return (
      draft.text.trim().length > 0 ||
      draft.images.length > 0 ||
      Object.keys(draft.pastedTextFiles ?? {}).length > 0
    )
  })
}

type Answer = { autoClose?: unknown }

export function useBotChatAutoClose(
  bot: Bot | null,
  sessionId: string,
  isVisible: boolean
): {
  view: BotChatAutoCloseView | null
  now: number
  keepOpen: () => void
  closeNow: () => void
} {
  const [view, setView] = useState<BotChatAutoCloseView | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const botId = bot?.id ?? null
  const hostId = bot?.hostId ?? null
  const call = useCallback(
    (method: string, extra?: Record<string, unknown>) => {
      if (!botId || !hostId) {
        return
      }
      void callBotRpc<Answer>({ hostId }, method, { sessionId, ...extra }, RPC_OPTIONS)
        .then((answer) => setView(readBotChatAutoCloseView(answer?.autoClose)))
        .catch(() => undefined)
    },
    [botId, hostId, sessionId]
  )

  useEffect(() => {
    if (!botId || !hostId) {
      setView(null)
      return
    }
    call('bots.chat.autoClose')
    return onBotsChanged(() => call('bots.chat.autoClose'), hostId, {
      botId,
      kinds: ['chats']
    })
  }, [botId, hostId, call])

  const closesAt = view?.phase === 'counting' ? view.closesAt : null
  useEffect(() => {
    if (closesAt === null) {
      return
    }
    // The text changes only as each whole minute left passes, and not at all in the last one.
    let timer: ReturnType<typeof setTimeout> | undefined
    const turn = (): void => {
      const current = Date.now()
      setNow(current)
      const left = closesAt - current
      if (left > 60_000) {
        timer = setTimeout(turn, (left % 60_000 || 60_000) + MINUTE_TURN_SLACK_MS)
      }
    }
    turn()
    return () => clearTimeout(timer)
  }, [closesAt])

  const focused = useSyncExternalStore(subscribeWindowFocus, readWindowFocus)
  const unsent = useHasUnsentMessage(sessionId)
  const holding = botChatAutoCloseHolds({ view, visible: isVisible, focused, unsent })
  useEffect(() => {
    if (!holding) {
      return
    }
    call('bots.chat.autoCloseHold', { holder: HOLDER, hold: true })
    // The lease's heartbeat: it runs only while this window holds the chat, and stops with it.
    const renew = setInterval(
      () => call('bots.chat.autoCloseHold', { holder: HOLDER, hold: true }),
      HOLD_RENEW_MS
    )
    return () => {
      clearInterval(renew)
      call('bots.chat.autoCloseHold', { holder: HOLDER, hold: false })
    }
  }, [holding, call])

  return {
    view,
    now,
    keepOpen: () => call('bots.chat.keepOpen'),
    closeNow: () => call('bots.chat.closeNow')
  }
}
