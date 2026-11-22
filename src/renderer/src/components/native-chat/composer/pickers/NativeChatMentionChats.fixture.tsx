// The `@` list one level under a bot: each picker state in the mock, from the real menu components.
import { useMemo, useRef } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { BotAvatarTile } from '../../../bots/BotAvatar'
import { BotChatStatusSlot } from '../../../bots/BotChatOriginIcon'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import type {
  NativeChatBotChatPicker,
  NativeChatMentionChat,
  NativeChatMentionChatsView
} from '../../native-chat-mention-chats'
import type { NativeChatMentionChatDrill } from './use-native-chat-mention-chat-drill'
import type { NativeChatRoomMention } from '../native-chat-composer-types'
import type { BotChatTreeChat } from '../../../../../../shared/bots/bot-chat-tree'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'

const avatar = (emoji: string, size = 'size-5') => (
  <BotAvatarTile src={null} fallback={emoji} className={`${size} shrink-0 rounded-sm text-2xs`} />
)
const BOTS = [
  {
    name: 'Perf bot',
    id: 'perf',
    icon: avatar('🐙'),
    detail: 'Owns Orca performance audits and fixes'
  },
  {
    name: 'Release bot',
    id: 'release',
    icon: avatar('🦉'),
    detail: 'Drafts release notes from merged PRs'
  },
  {
    name: 'Docs bot',
    id: 'docs',
    icon: avatar('🐢'),
    detail: 'Keeps the user docs current',
    unavailable: 'Paused'
  }
]
const icon = (origin: BotChatTreeChat['origin'], live: BotChatTreeChat['live'] = 'idle') => (
  <BotChatStatusSlot chat={{ origin, live }} className="h-5 w-4" iconClassName="size-3.5" />
)
const row = (
  id: string,
  title: string,
  line: React.ReactNode,
  time: string,
  glyph: React.ReactNode,
  plain = false
): NativeChatMentionChat => ({
  id,
  title,
  search: `${title}\n${typeof line === 'string' ? line : ''}`,
  icon: glyph,
  line,
  time,
  plain
})
const waiting = (place: string) => (
  <>
    {place} · <span className="text-foreground">Waiting for you</span>
  </>
)
const PERF_CHATS = [
  row(
    'home',
    'Home Chat',
    'Profiled cold start on the M1, 2 regressions filed',
    '4m',
    icon('home'),
    true
  ),
  row(
    'win',
    'Why is the terminal slow on Windows',
    waiting('#perf'),
    '3h',
    icon('slack', 'needs-you')
  ),
  row('relay', 'Relay reconnect audit', 'Replying…', 'now', icon('side', 'replying')),
  row(
    'notes',
    'Release notes perf section',
    'Drafted the perf part of the 1.4.230 notes',
    '26m',
    icon('side')
  ),
  row(
    'grafana',
    'Can the bot read perf dashboards?',
    '#bots · Yes, with the Grafana tool',
    '2h',
    icon('slack')
  ),
  row(
    'nightly',
    'Nightly startup benchmark',
    'Cold start 1.42 s, within budget',
    '9h',
    icon('automation')
  ),
  row('leak', 'Memory leak in the diff viewer', 'Fixed in #31877', '2d', icon('side'))
]

function picker(
  chats: NativeChatMentionChatsView | null,
  selfId: string | null = null
): NativeChatBotChatPicker {
  return {
    offers: (id) => id !== 'docs',
    selfId,
    watch: () => {},
    prefetch: () => {},
    view: () => {},
    shown: chats
      ? { botId: 'perf', name: 'Perf bot', avatar: avatar('🐙', 'size-4'), chats }
      : null,
    retry: () => {},
    token: () => '',
    pick: () => ({ state: 'ok' }),
    title: () => null
  }
}

function drill(filter: string | null): NativeChatMentionChatDrill {
  return {
    open: filter === null ? null : { botId: 'perf', filter },
    parent: null,
    activeIndex: 0,
    setActiveIndex: () => {},
    enter: () => {},
    back: () => {},
    pick: () => {},
    onKey: () => false
  }
}

function Frame({
  typed,
  files,
  chats,
  filter = null,
  mentions = BOTS
}: {
  typed: string
  files: string[]
  chats: NativeChatMentionChatsView | null
  filter?: string | null
  mentions?: readonly NativeChatRoomMention[]
}): React.JSX.Element {
  const listboxId = useRef(`chats-${typed.length}`).current
  const room = useMemo(
    () => ({
      replies: null,
      mentions,
      withFiles: true,
      unavailable: mentions.filter((bot) => bot.unavailable).map((bot) => bot.name),
      chats: { picker: picker(chats), drill: drill(filter) }
    }),
    [chats, filter, mentions]
  )
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4 pt-[300px]"
      style={nativeChatAppearanceStyle({})}
    >
      <NativeChatRoomContext.Provider value={room}>
        <div className="relative">
          <NativeChatMentionMenu
            mention={{ files, loading: false, failed: false }}
            activeIndex={0}
            listboxId={listboxId}
            onChoose={() => {}}
          />
          <div className="rounded-xl border border-chat-composer-border bg-chat-composer-surface px-3 py-3 text-sm">
            {typed}
            <span className="ml-px inline-block h-4 w-px translate-y-0.5 bg-foreground" />
          </div>
        </div>
      </NativeChatRoomContext.Provider>
    </div>
  )
}

const ready = (chats: NativeChatMentionChat[]): NativeChatMentionChatsView => ({
  status: 'ready',
  chats
})

/** 1. `@`: today's rows; the highlighted bot row shows Chats › beside it; a paused bot has none. */
export const bots = defineFixture({
  width: 560,
  render: () => (
    <Frame
      typed="Ask @"
      files={['Perf bot', 'Release bot', 'README.md', 'src/main/startup.ts']}
      chats={null}
    />
  )
})

/** 2. → or Chats ›: the bot's chats loading under "‹ Perf bot"; the text is unchanged. */
export const loading = defineFixture({
  width: 560,
  render: () => <Frame typed="Ask @" files={[]} chats={{ status: 'loading' }} filter="" />
})

/** 3. Loaded: the chats this chat can mail, as the Activity panel's rows; scrolls inside 288px. */
export const loaded = defineFixture({
  width: 560,
  render: () => <Frame typed="Ask @" files={[]} chats={ready(PERF_CHATS)} filter="" />
})

/** 4. Typing filters the chats, spaces included. */
export const filtered = defineFixture({
  width: 560,
  render: () => (
    <Frame typed="Ask @release notes" files={[]} chats={ready(PERF_CHATS)} filter="release notes" />
  )
})

/** Only the Home Chat: "No other chats". */
export const noOtherChats = defineFixture({
  width: 420,
  render: () => <Frame typed="Ask @" files={[]} chats={ready(PERF_CHATS.slice(0, 1))} filter="" />
})

/** A filter nothing matches: "No matching chats" (Enter sends nothing). */
export const noMatchingChats = defineFixture({
  width: 420,
  render: () => (
    <Frame
      typed="Ask @grafana alerts"
      files={[]}
      chats={ready(PERF_CHATS)}
      filter="grafana alerts"
    />
  )
})

/** The bot's computer can't be reached: why, and Retry. */
export const loadFailed = defineFixture({
  width: 420,
  render: () => (
    <Frame
      typed="Ask @rel"
      files={[]}
      chats={{ status: 'error', message: "Couldn't load chats: build-box isn't connected" }}
      filter="rel"
    />
  )
})

/** In a bot's own chat that bot is listed first, for its other chats. */
export const ownBot = defineFixture({
  width: 420,
  render: () => (
    <Frame
      typed="Check with @"
      files={['Release bot', 'Perf bot']}
      chats={null}
      mentions={[
        { name: 'Release bot', id: 'release', icon: avatar('🦉'), note: 'Your other chats' },
        BOTS[0]
      ]}
    />
  )
})

/** The same long title twice: cut short, told apart by icon, second line and time. */
export const longTitles = defineFixture({
  width: 420,
  render: () => (
    <Frame
      typed="Ask @windows"
      files={[]}
      filter="windows"
      chats={ready([
        row(
          'a',
          'Why is the Windows terminal slow when a large repo with many submodules is open',
          waiting('#perf'),
          '3h',
          icon('slack', 'needs-you')
        ),
        row(
          'b',
          'Why is the Windows terminal slow when a large repo with many submodules is open',
          'Repro on the Surface: 4.1 s first paint',
          '2d',
          icon('side')
        )
      ])}
    />
  )
})
