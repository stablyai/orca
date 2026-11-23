// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerMentions } from '../native-chat/native-chat-composer-room'
import { NativeChatBotChatRoomContext } from '../native-chat/native-chat-room-context'
import { useBotChatComposerRoom } from './use-bot-chat-composer-room'

const BOTS = [
  { id: 'perf', hostId: 'local', name: 'Perf bot', paused: false },
  { id: 'docs', hostId: 'local', name: 'Docs bot', paused: true },
  { id: 'build', hostId: 'runtime:m4', name: 'Build bot', paused: false },
  // Same name as this computer's bot, on another computer: both list.
  { id: 'perf-m4', hostId: 'runtime:m4', name: 'Perf bot', paused: false }
]
const PERF = 'local\u0000perf'
const DOCS = 'local\u0000docs'
const BUILD = 'runtime:m4\u0000build'
const PERF_M4 = 'runtime:m4\u0000perf-m4'
const self = vi.hoisted((): { bot: { id: string; hostId: string } | null } => ({ bot: null }))
const roster = vi.hoisted(() => vi.fn())

vi.mock('@/lib/bot-catalog', () => ({
  useBots: (enabled: boolean) => (enabled ? BOTS : []),
  useBotsEnabled: () => true
}))
vi.mock('./bot-workspace', () => ({ useBotForWorkspace: () => self.bot }))
vi.mock('./BotAvatar', () => ({ BotAvatar: () => null }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: roster }))
vi.mock('../native-chat/composer/pickers/use-native-chat-mention-files', () => ({
  useNativeChatMentionFiles: () => ({ files: ['src/perf.ts'], loading: false, failed: false })
}))

beforeEach(() => {
  self.bot = null
  roster.mockReset()
  roster.mockResolvedValue({
    bots: [{ id: 'perf', specialty: 'Owns Orca performance audits and fixes' }]
  })
})

const CLOSED: { query: string | null } = { query: null }

function chat(hostId: 'local' | `runtime:${string}` | null = 'local') {
  const completeMention = vi.fn()
  function Room({ children }: { children: ReactNode }): React.JSX.Element {
    const room = useBotChatComposerRoom('repo::/work/tree', hostId)
    return (
      <NativeChatBotChatRoomContext.Provider value={room}>
        {children}
      </NativeChatBotChatRoomContext.Provider>
    )
  }
  const { result, rerender } = renderHook(
    ({ query }: { query: string | null }) =>
      useNativeChatComposerMentions(
        undefined,
        '@',
        {
          autocomplete:
            query === null ? { mode: 'none' } : { mode: 'mention', query, triggerKey: '@:0' },
          completeMention
        },
        { terminalTabId: 'tab', structuredWorktreeId: 'repo::/work/tree' }
      ),
    { wrapper: Room, initialProps: CLOSED }
  )
  return { result, completeMention, openAt: () => rerender({ query: '' }) }
}

it("lists the owner's bots above files in a workspace chat, paused ones unpickable", async () => {
  const { result, completeMention, openAt } = chat()
  openAt()
  expect(result.current.mentionFiles.files).toEqual([PERF, BUILD, PERF_M4, 'src/perf.ts'])
  expect(result.current.roomContext?.unavailable).toEqual([DOCS])
  await waitFor(() =>
    expect(result.current.roomContext?.mentions[0]?.detail).toBe(
      'Owns Orca performance audits and fixes'
    )
  )

  act(() => result.current.chooseMention(PERF))
  expect(completeMention).toHaveBeenCalledWith(PERF, '[Bot: Perf bot](bot:perf)')
})

it('reads what bots are for only once `@` opens, once for every chat open at the time', async () => {
  const first = chat()
  const second = chat()
  expect(roster).not.toHaveBeenCalled()

  first.openAt()
  second.openAt()
  await waitFor(() => expect(second.result.current.roomContext?.mentions[0]?.detail).toBeTruthy())
  expect(roster).toHaveBeenCalledTimes(1)
})

it("names a picked bot by id in a bot's own chat too, as in any other chat", () => {
  self.bot = { id: 'docs', hostId: 'local' }
  const { result, completeMention, openAt } = chat()
  openAt()
  act(() => result.current.chooseMention(PERF))
  expect(completeMention).toHaveBeenCalledWith(PERF, '[Bot: Perf bot](bot:perf)')
})

it("lists a paired server's bots after this computer's, with its pill, dimmed while it is down, named with its server", () => {
  const { result, completeMention, openAt } = chat()
  openAt()
  const build = result.current.roomContext?.mentions.find((mention) => mention.name === 'Build bot')
  expect(build?.host).toBeTruthy()
  expect(build?.dimmed).toBe(true)
  expect(result.current.roomContext?.mentions.find((m) => m.key === PERF)?.host).toBe(undefined)

  act(() => result.current.chooseMention(BUILD))
  expect(completeMention).toHaveBeenCalledWith(BUILD, '[Bot: Build bot](bot:build@m4)')
  act(() => result.current.chooseMention(PERF_M4))
  expect(completeMention).toHaveBeenCalledWith(PERF_M4, '[Bot: Perf bot](bot:perf-m4@m4)')
})

it("lists only that server's bots in a chat on a paired server", () => {
  const { result, openAt } = chat('runtime:m4')
  openAt()
  expect(result.current.mentionFiles.files).toEqual([BUILD, PERF_M4, 'src/perf.ts'])
})

it('lists no bots where the chat runs on a computer with none listed here', () => {
  const { result, openAt } = chat('runtime:linux')
  openAt()
  expect(result.current.mentionFiles.files).toEqual(['src/perf.ts'])
  expect(roster).not.toHaveBeenCalled()
})
