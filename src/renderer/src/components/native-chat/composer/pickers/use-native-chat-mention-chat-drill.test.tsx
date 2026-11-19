// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent } from 'react'
import { expect, it, vi } from 'vitest'
import type {
  NativeChatBotChatPicker,
  NativeChatMentionChat
} from '../../native-chat-mention-chats'
import { useNativeChatMentionChatDrill } from './use-native-chat-mention-chat-drill'

const chat = (id: string, title: string, plain = false): NativeChatMentionChat => ({
  id,
  title,
  search: title,
  icon: null,
  line: '',
  time: null,
  plain
})
const CHATS = [
  chat('home', 'Home Chat', true),
  chat('relay', 'Relay reconnect audit'),
  chat('notes', 'Release notes perf section')
]
const picker: NativeChatBotChatPicker = {
  offers: (botId) => botId === 'perf',
  selfId: null,
  watch: () => {},
  prefetch: () => {},
  view: () => {},
  shown: {
    botId: 'perf',
    name: 'Perf bot',
    avatar: null,
    chats: { status: 'ready', chats: CHATS }
  },
  retry: () => {},
  token: (botId, picked) =>
    picked && !picked.plain
      ? `[Bot: Perf bot](bot-chat:${botId}/${picked.id})`
      : '[Bot: Perf bot](bot:perf)',
  pick: () => ({ state: 'ok' }),
  title: () => null
}

function key(name: string): KeyboardEvent<HTMLElement> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields
  return {
    key: name,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    preventDefault: vi.fn()
  } as unknown as KeyboardEvent<HTMLElement>
}

it('opens a bot’s chats without editing the text, filters past spaces, and picks one in place of the @ text', () => {
  const complete = vi.fn()
  const { result, rerender } = renderHook(
    ({ draft }) =>
      useNativeChatMentionChatDrill({
        picker,
        draft,
        caret: draft.length,
        mentionOpen: draft.endsWith('@'),
        complete
      }),
    { initialProps: { draft: 'Ask @' } }
  )
  act(() => {
    expect(result.current.onKey(key('ArrowRight'), 'perf')).toBe(true)
  })
  expect(result.current.open).toEqual({ botId: 'perf', filter: '' })

  // Spaces close the `@` trigger but not the chats; the filter is what was typed since.
  rerender({ draft: 'Ask @release notes' })
  expect(result.current.open).toEqual({ botId: 'perf', filter: 'release notes' })
  act(() => {
    result.current.onKey(key('Enter'), null)
  })
  expect(complete).toHaveBeenCalledWith(4, '[Bot: Perf bot](bot-chat:perf/notes)')
})

it('goes back to the bots on Esc, or ← with nothing typed, never editing the text', () => {
  const complete = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatMentionChatDrill({ picker, draft: 'Ask @', caret: 5, mentionOpen: true, complete })
  )
  act(() => {
    result.current.enter('perf')
  })
  act(() => {
    expect(result.current.onKey(key('ArrowLeft'), null)).toBe(true)
  })
  expect(result.current.open).toBeNull()
  act(() => {
    result.current.enter('perf')
  })
  act(() => {
    result.current.onKey(key('Escape'), null)
  })
  expect(result.current.open).toBeNull()
  // The Home Chat row gives the plain bot pill; nothing matching sends nothing.
  act(() => {
    result.current.enter('perf')
  })
  act(() => {
    result.current.onKey(key('Enter'), null)
  })
  expect(complete).toHaveBeenCalledWith(4, '[Bot: Perf bot](bot:perf)')
  expect(complete).toHaveBeenCalledTimes(1)
})
