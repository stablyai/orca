// A bot's chats opened from the `@` list. Opening never edits the text: this holds which bot is open
// and where, and the filter is whatever is typed after that point, spaces included.
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type {
  NativeChatBotChatPicker,
  NativeChatMentionChat
} from '../../native-chat-mention-chats'
import { nativeChatMentionChatOptions } from './NativeChatMentionChatList'

type DrillAt = {
  /** The open bot; null once Esc went back to the bots, which stay open over the same `@`. */
  botId: string | null
  /** Back at the bots: the text typed after `at` then, which must not change for them to stay. */
  backWith?: string
  /** Where the `@` starts: a pick replaces from here to the caret. */
  from: number
  /** The caret when the chats opened; the filter is the text after it. */
  at: number
  /** The text before `at`, which must stay as it was for the chats to stay open. */
  before: string
}

export type NativeChatMentionChatDrill = {
  /** The open bot and the filter typed since; null while the bots show. */
  open: { botId: string; filter: string } | null
  /** Back at the bots after a filter the `@` trigger can't hold (spaces): where its `@` starts
   *  and the query the bots were found by. The bots stay open until the text changes. */
  parent: { from: number; query: string } | null
  activeIndex: number
  setActiveIndex: (index: number) => void
  /** Opens a bot's chats from its row, over the `@query` under the caret. */
  enter: (botId: string) => void
  back: () => void
  pick: (chat: NativeChatMentionChat) => void
  /** Keys while the `@` list is open; true when the key was the list's. */
  onKey: (event: KeyboardEvent<HTMLElement>, highlightedBotId: string | null) => boolean
}

export function useNativeChatMentionChatDrill({
  picker,
  draft,
  caret,
  mentionOpen,
  mentionQuery,
  complete
}: {
  picker: NativeChatBotChatPicker | undefined
  draft: string
  caret: number
  /** The `@` list shows (its trigger is under the caret). */
  mentionOpen: boolean
  /** The `@` query before the caret, which may hold spaces while a bot's name matches (`@eng n`). */
  mentionQuery?: string | null
  /** Replaces `from` to the caret with `token` and a space. */
  complete: (from: number, token: string) => void
}): NativeChatMentionChatDrill {
  const [drill, setDrill] = useState<DrillAt | null>(null)
  // The highlighted chat, for the bot and filter it was moved under; any other starts at the top.
  const [moved, setMoved] = useState<{ key: string; index: number } | null>(null)
  // Editing before the point the chats opened at, or leaving it, closes them.
  const typed = drill ? draft.slice(drill.at, caret) : ''
  const live =
    drill !== null &&
    caret >= drill.at &&
    draft.startsWith(drill.before) &&
    !typed.includes('\n') &&
    (drill.botId !== null || typed === drill.backWith)
      ? drill
      : null
  const openBot = live?.botId ?? null
  const filter = openBot ? typed : ''
  const open = useMemo(() => (openBot ? { botId: openBot, filter } : null), [openBot, filter])
  const parentAt = live && !openBot ? live : null
  const parent = useMemo(
    () =>
      parentAt ? { from: parentAt.from, query: parentAt.before.slice(parentAt.from + 1) } : null,
    [parentAt]
  )
  // Once the text no longer holds where the chats opened, they stay closed even if it comes back.
  if (drill !== null && live === null) {
    setDrill(null)
  }
  const listKey = openBot ? `${openBot}\n${filter}` : ''
  const activeIndex = moved?.key === listKey ? moved.index : 0
  const setActiveIndex = useCallback(
    (index: number) => setMoved({ key: listKey, index }),
    [listKey]
  )
  const view = picker?.view
  useEffect(() => {
    view?.(openBot)
  }, [view, openBot])

  const enter = useCallback(
    (botId: string) => {
      // Back at the bots over the same `@`: the text typed after it is the filter again.
      if (parentAt) {
        setDrill({ ...parentAt, botId, backWith: undefined })
        return
      }
      const query = mentionQuery ?? draft.slice(0, caret).match(/@(\S*)$/)?.[1] ?? ''
      setDrill({
        botId,
        from: caret - query.length - 1,
        at: caret,
        before: draft.slice(0, caret)
      })
    },
    [caret, draft, mentionQuery, parentAt]
  )
  // The bots come back over the same `@`, whatever was typed to filter the chats.
  const back = useCallback(() => {
    setDrill((current) => current && { ...current, botId: null, backWith: typed })
  }, [typed])
  const pick = useCallback(
    (chat: NativeChatMentionChat) => {
      if (!live || !openBot || !picker) {
        return
      }
      const token = picker.token(openBot, chat)
      setDrill(null)
      if (token) {
        complete(live.from, token)
      }
    },
    [complete, live, openBot, picker]
  )

  const onKey = useCallback(
    (event: KeyboardEvent<HTMLElement>, highlightedBotId: string | null): boolean => {
      const plain = !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
      if (!picker) {
        return false
      }
      if (!openBot) {
        // Esc at the bots closes them, as it closes the `@` list.
        if (parentAt && event.key === 'Escape') {
          setDrill(null)
          return false
        }
        if (!(mentionOpen || parentAt) || !highlightedBotId || !picker.offers(highlightedBotId)) {
          return false
        }
        // → opens a row's chats only with the caret at the end of the `@` text; else it moves.
        const atEnd = caret >= draft.length || /\s/.test(draft[caret] ?? '')
        const opens =
          (event.key === 'ArrowRight' && plain && atEnd) ||
          // The chat's own bot alone would be this chat's own bot: its row opens its chats.
          ((event.key === 'Enter' || event.key === 'Tab') &&
            !event.shiftKey &&
            highlightedBotId === picker.selfId)
        if (!opens) {
          return false
        }
        event.preventDefault()
        enter(highlightedBotId)
        return true
      }
      const options = picker.shown ? nativeChatMentionChatOptions(picker.shown, filter) : []
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault()
          if (options.length > 0) {
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActiveIndex((activeIndex + step + options.length) % options.length)
          }
          return true
        case 'Enter':
        case 'Tab': {
          if (event.shiftKey) {
            return false
          }
          // Nothing to pick (still loading, or nothing matches) is no send either.
          event.preventDefault()
          const chosen = options[Math.min(activeIndex, options.length - 1)]
          if (chosen) {
            pick(chosen)
          }
          return true
        }
        case 'Escape':
          event.preventDefault()
          back()
          return true
        case 'ArrowLeft':
        case 'Backspace':
          if (filter !== '' || !plain) {
            return false
          }
          event.preventDefault()
          back()
          return true
        default:
          return false
      }
    },
    [
      activeIndex,
      back,
      caret,
      draft,
      enter,
      filter,
      mentionOpen,
      openBot,
      parentAt,
      pick,
      picker,
      setActiveIndex
    ]
  )

  return { open, parent, activeIndex, setActiveIndex, enter, back, pick, onKey }
}
