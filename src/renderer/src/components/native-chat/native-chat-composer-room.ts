import { useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { rankNativeChatRoomMembers } from '../../../../shared/native-chat/input/native-chat-room-mentions'
import { botMentionsAt } from '../../../../shared/bots/bot-mention-context'
import {
  nativeChatMentionValue,
  type NativeChatComposerRoom
} from './composer/native-chat-composer-types'
import type { NativeChatComposerNotice } from './composer/controls/native-chat-composer-notice'
import type { NativeChatBotChatPicker } from './native-chat-mention-chats'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
// The composer pane provides the room it reads here.
export { NativeChatRoomContext } from './native-chat-room-context'
import {
  NativeChatBotChatPickerContext,
  NativeChatBotChatRoomContext
} from './native-chat-room-context'
import {
  useNativeChatMentionFiles,
  type NativeChatMentionFiles
} from './composer/pickers/use-native-chat-mention-files'
import { useNativeChatMentionChatDrill } from './composer/pickers/use-native-chat-mention-chat-drill'
import { useSpacedMemberQuery } from './composer/pickers/use-native-chat-spaced-mention'
import { nativeChatMentionChatOptions } from './composer/pickers/NativeChatMentionChatList'
import {
  NativeChatCrewContext,
  useNativeChatCrewState
} from '../orchestration-crew/use-native-chat-crew'
import {
  crewAgentMentions,
  NO_CREW_AGENT_MENTIONS
} from '../orchestration-crew/native-chat-crew-mentions'
import type { NativeChatMentionToken } from './composer/editor/native-chat-composer-input'

const memberOf = (room: NativeChatComposerRoom | undefined, value: string) =>
  room?.mentions.find((mention) => nativeChatMentionValue(mention) === value)

const NO_MATCHES: NativeChatMentionFiles = { files: [], loading: false, failed: false }
const NO_NOTICES: readonly NativeChatComposerNotice[] = []
const NO_VALUES: readonly string[] = []
const NO_MEMBERS: NativeChatComposerRoom['mentions'] = []

/** `@` names workspace files, or in a room its members (the owner's bots above the files in any other
 *  chat), in the file menu's shape so keys are shared; a bot's row opens its chats one level down. */
export function useNativeChatComposerMentions(
  ownRoom: NativeChatComposerRoom | undefined,
  draft: string,
  picker: {
    autocomplete: ComposerAutocomplete
    completeMention: (path: string, token?: NativeChatMentionToken, from?: number) => void
  },
  {
    caret: caretAt,
    notices = NO_NOTICES,
    ...files
  }: {
    terminalTabId: string
    structuredWorktreeId: string | undefined
    caret?: number
    /** The composer's own notices; a picked chat that can't go adds its own. */
    notices?: readonly NativeChatComposerNotice[]
  }
) {
  const t = useTranslate()
  const caret = caretAt ?? draft.length
  const { completeMention } = picker
  // Other chats list the owner's bots (a bot's own chat, its other bots); a group room brings its own members.
  const botChatRoom = useContext(NativeChatBotChatRoomContext)
  const chatPicker = useContext(NativeChatBotChatPickerContext)
  const room = ownRoom ?? botChatRoom
  const typed = picker.autocomplete.mode === 'mention' ? picker.autocomplete.query : null
  const spaced = useSpacedMemberQuery(typed === null ? room : null, draft, caret)
  const typedQuery = typed ?? spaced?.query ?? null
  // A group room keeps its own `@name` recipients: its members' chats are never offered there.
  const drillPicker = ownRoom ? undefined : chatPicker
  const complete = useCallback(
    (from: number, token: string) => completeMention('', token, from),
    [completeMention]
  )
  const drill = useNativeChatMentionChatDrill({
    picker: drillPicker,
    draft,
    caret,
    mentionOpen: typedQuery !== null,
    complete
  })
  // Back from a bot's chats, the bots show for the `@query` they were found by.
  const query = drill.parent?.query ?? typedQuery
  const opened = query !== null && !ownRoom ? botChatRoom?.opened : undefined
  useEffect(() => {
    opened?.()
  }, [opened])
  const workspaceFiles = useNativeChatMentionFiles({
    ...files,
    query: room && !room.withFiles ? null : query
  })
  // The strip's own crew subscription: rows only while `@` is open, never a read per keystroke.
  const crew = useContext(NativeChatCrewContext)
  const menuOpen = query !== null
  const crewRows = useNativeChatCrewState(menuOpen ? crew : null).rows
  const wantCrewRows = menuOpen ? crew?.wantRows : undefined
  useEffect(() => wantCrewRows?.(), [wantCrewRows])
  const crewHost = crew
    ? crew.target.kind === 'local'
      ? 'local'
      : crew.target.environmentId
    : null
  const crewAgents = useMemo(
    () =>
      crewRows && crewHost ? crewAgentMentions(crewRows, crewHost, t) : NO_CREW_AGENT_MENTIONS,
    [crewRows, crewHost, t]
  )
  const agents = useMemo(
    () => (query !== null ? rankNativeChatRoomMembers(crewAgents.mentions, query) : NO_VALUES),
    [crewAgents, query]
  )
  const ranked = useMemo(
    () => (room && query !== null ? rankNativeChatRoomMembers(room.mentions, query) : null),
    [room, query]
  )
  const pickable = useMemo(
    () => ranked?.filter((value) => !memberOf(room, value)?.unavailable) ?? [],
    [ranked, room]
  )
  const mentionFiles = useMemo<NativeChatMentionFiles>(() => {
    // The room's bots lead the list, above this chat's crew agents.
    if (!room) {
      return agents.length > 0
        ? { ...workspaceFiles, files: [...agents, ...workspaceFiles.files] }
        : workspaceFiles
    }
    if (room.withFiles) {
      return { ...workspaceFiles, files: [...pickable, ...agents, ...workspaceFiles.files] }
    }
    return query === null
      ? NO_MATCHES
      : { files: [...pickable, ...agents], loading: false, failed: false }
  }, [room, query, agents, pickable, workspaceFiles])
  const botIdOf = useCallback((value: string) => memberOf(room, value)?.id ?? null, [room])
  const chooseMention = useCallback(
    (value: string) => {
      const agent = crewAgents.references.get(value)
      if (agent) {
        completeMention(value, agent, drill.parent?.from)
        return
      }
      const id = botIdOf(value)
      // The chat's own bot alone is this chat's bot: its row opens its other chats instead.
      if (id !== null && drillPicker && id === drillPicker.selfId) {
        drill.enter(id)
        return
      }
      const token = ownRoom ? undefined : botChatRoom?.token?.(value)
      const member = memberOf(room, value)
      // Back from a bot's chats, the pick replaces the `@` and the filter typed after it.
      const picked = member ? (token ?? `@${member.name}`) : undefined
      const from = drill.parent?.from ?? spaced?.from
      if (from === undefined) {
        completeMention(value, picked)
      } else {
        completeMention(value, picked, from)
      }
    },
    [botIdOf, drillPicker, drill, completeMention, room, ownRoom, botChatRoom, crewAgents, spaced]
  )

  const chosen = useBotChatPillChecks(draft, chatPicker)
  const roomContext = useMemo(
    () =>
      room
        ? {
            replies: room.replies?.(draft) ?? null,
            mentions: room.mentions,
            withFiles: room.withFiles === true,
            unavailable: ranked?.filter((name) => !pickable.includes(name)) ?? [],
            agents: crewAgents.mentions,
            ...(drillPicker ? { chats: { picker: drillPicker, drill } } : {})
          }
        : crewAgents.mentions.length > 0
          ? {
              replies: null,
              mentions: NO_MEMBERS,
              withFiles: true,
              unavailable: NO_VALUES,
              agents: crewAgents.mentions
            }
          : null,
    [room, draft, ranked, pickable, drillPicker, drill, crewAgents]
  )

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLElement>, activeSuggestion: number): boolean => {
      // Alt+↓ opens the chat list of the bot pill beside the caret.
      if (event.key === 'ArrowDown' && event.altKey && !event.metaKey && !event.ctrlKey) {
        const index = chosen.pills.findIndex(
          (entry) => entry.start <= caret && caret <= entry.end + 1
        )
        const pill = chosen.pills[index]
        if (pill && chatPicker && (pill.chatId || chatPicker.offers(pill.id))) {
          event.preventDefault()
          chosen.chooser.open(index)
          return true
        }
        return false
      }
      if (event.key === 'Escape' && spaced && !drill.open) {
        event.preventDefault()
        drill.onKey(event, null)
        spaced.dismiss()
        return true
      }
      const files = mentionFiles.files
      const highlighted =
        query !== null && files.length > 0
          ? botIdOf(files[Math.min(activeSuggestion, files.length - 1)] ?? '')
          : null
      return drill.onKey(event, highlighted)
    },
    [botIdOf, caret, chatPicker, chosen, drill, mentionFiles.files, query, spaced]
  )

  const notice = useMemo((): NativeChatComposerNotice | null => {
    const held = chosen.held
    if (!held || held.pick.state !== 'unavailable') {
      return null
    }
    const { retry } = held.pick
    return {
      key: 'bot-chat-unavailable',
      kind: 'error',
      text: typeof held.pick.why === 'string' ? held.pick.why : '',
      content: held.pick.why,
      action: retry
        ? { label: t('components.native-chat.composer.retryChats', 'Retry'), onClick: retry }
        : {
            label: t('components.native-chat.composer.chooseChat', 'Choose chat'),
            onClick: () => chosen.chooser.open(held.index)
          }
    }
  }, [chosen, t])

  const drilled = drill.open !== null
  const parentFrom = drilled ? null : (drill.parent?.from ?? spaced?.from ?? null)
  // A bot's chats, the bots after going back from them, and a bot's name typed with its spaces keep
  // the `@` list open while the text after the `@` has spaces its trigger can't hold.
  const autocomplete = useMemo<ComposerAutocomplete>(
    () =>
      (drilled || parentFrom !== null) && picker.autocomplete.mode !== 'mention'
        ? { mode: 'mention', query: query ?? '', triggerKey: `@:${parentFrom ?? 'chats'}` }
        : picker.autocomplete,
    [drilled, parentFrom, picker.autocomplete, query]
  )
  // While a bot's chats show, the focused editor names their highlighted option, not a bot's.
  const shown = drillPicker?.shown
  const chatOptions = useMemo(
    () =>
      drill.open && shown?.botId === drill.open.botId
        ? nativeChatMentionChatOptions(shown, drill.open.filter)
        : null,
    [drill.open, shown]
  )
  const listed = useMemo<NativeChatMentionFiles>(
    () =>
      drilled
        ? { files: chatOptions?.map((chat) => chat.id) ?? [], loading: false, failed: false }
        : mentionFiles,
    [drilled, chatOptions, mentionFiles]
  )
  const allNotices = useMemo(() => (notice ? [...notices, notice] : notices), [notices, notice])

  return {
    autocomplete,
    notices: allNotices,
    /** The `@` list's options: a bot's chats while they show (by id), else bots and files. */
    listed,
    /** The highlighted option among `listed` while a bot's chats show; else the composer's own. */
    activeIndex: drilled ? drill.activeIndex : null,
    mentionFiles,
    chooseMention,
    roomContext,
    hint: room?.placeholder,
    handleKey,
    /** A picked chat Send can't carry yet: still being checked, or unavailable. */
    sendHeld: chosen.held !== null,
    chooser: chosen.chooser
  }
}

/** The draft's chat pills, kept checked: the first one Send can't carry, and which pill's chat list
 *  is open. Nothing is sent in a picked chat's place, so any doubt holds Send. */
function useBotChatPillChecks(draft: string, picker: NativeChatBotChatPicker | undefined) {
  const pills = useMemo(() => botMentionsAt(draft), [draft])
  const chatBots = useMemo(
    () => [...new Set(pills.filter((pill) => pill.chatId).map((pill) => pill.id))],
    [pills]
  )
  const watch = picker?.watch
  const watchKey = chatBots.join('|')
  useEffect(() => {
    watch?.(watchKey ? watchKey.split('|') : [])
  }, [watch, watchKey])
  const held = firstHeldPill(pills, picker)
  const [at, setAt] = useState<number | null>(null)
  const chooser = useMemo(
    () => ({ at, open: (index: number) => setAt(index), close: () => setAt(null) }),
    [at]
  )
  return useMemo(() => ({ pills, held, chooser }), [pills, held, chooser])
}

/** The first chat pill Send can't carry yet, with its place among the bot pills; null when none. */
function firstHeldPill(
  pills: ReturnType<typeof botMentionsAt>,
  picker: NativeChatBotChatPicker | undefined
) {
  for (const [index, pill] of pills.entries()) {
    if (!pill.chatId) {
      continue
    }
    const pick = picker
      ? picker.pick(pill.id, pill.chatId)
      : // No bots known here: nothing can say the chat takes mail.
        { state: 'checking' as const }
    if (pick.state !== 'ok') {
      return { ...pill, index, pick }
    }
  }
  return null
}
