// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { useNativeChatComposerMentions } from './native-chat-composer-room'
import { applyNativeChatMention } from './composer/editor/native-chat-composer-input'
import {
  NativeChatBotChatPickerContext,
  NativeChatBotChatRoomContext,
  type NativeChatBotChatRoom
} from './native-chat-room-context'
import type { NativeChatBotChatPicker, NativeChatMentionChat } from './native-chat-mention-chats'

vi.mock('./composer/pickers/use-native-chat-mention-files', () => ({
  useNativeChatMentionFiles: ({ query }: { query: string | null }) => ({
    files: query === null ? [] : ['src/main.ts'],
    loading: false,
    failed: false
  })
}))

const chat = (id: string, title: string, plain = false): NativeChatMentionChat => ({
  id,
  title,
  search: title,
  icon: null,
  line: '',
  time: null,
  plain
})
const picker: NativeChatBotChatPicker = {
  offers: () => true,
  selfId: null,
  watch: () => {},
  prefetch: () => {},
  view: () => {},
  shown: {
    botId: 'perf',
    name: 'Perf bot',
    avatar: null,
    chats: {
      status: 'ready',
      chats: [
        chat('home', 'Home Chat', true),
        chat('two', 'Two words here'),
        chat('words', 'More two words')
      ]
    }
  },
  retry: () => {},
  token: (botId, picked) =>
    picked && !picked.plain
      ? `[Bot: Perf bot](bot-chat:${botId}/${picked.id})`
      : `[Bot: Perf bot](bot:${botId})`,
  pick: () => ({ state: 'ok' }),
  title: () => null
}
const room: NativeChatBotChatRoom = {
  withFiles: true,
  mentions: [{ name: 'Perf bot', id: 'perf', icon: null }],
  placeholder: '',
  token: () => '[Bot: Perf bot](bot:perf)'
}

function wrapper({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <NativeChatBotChatRoomContext.Provider value={room}>
      <NativeChatBotChatPickerContext.Provider value={picker}>
        {children}
      </NativeChatBotChatPickerContext.Provider>
    </NativeChatBotChatRoomContext.Provider>
  )
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

// The `@` trigger the composer derives from the text: none once the text after `@` has a space.
function triggerOf(draft: string): ComposerAutocomplete {
  const found = draft.match(/(?:^|\s)@(\S*)$/)
  return found
    ? { mode: 'mention', query: found[1] ?? '', triggerKey: `@:${draft.length - found[0].length}` }
    : { mode: 'none' }
}

function mount() {
  const completeMention = vi.fn()
  const view = renderHook(
    ({ draft }: { draft: string }) =>
      useNativeChatComposerMentions(
        undefined,
        draft,
        { autocomplete: triggerOf(draft), completeMention },
        { terminalTabId: 'tab', structuredWorktreeId: undefined, caret: draft.length }
      ),
    { wrapper, initialProps: { draft: 'Ask @' } }
  )
  return { ...view, completeMention }
}

it('goes back to the bots on Left or Escape without editing the draft', () => {
  const { result, rerender, completeMention } = mount()
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  act(() => {
    expect(result.current.handleKey(key('ArrowLeft'), 0)).toBe(true)
  })
  expect(result.current.mentionFiles.files).toEqual(['Perf bot', 'src/main.ts'])
  expect(completeMention).not.toHaveBeenCalled()
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  rerender({ draft: 'Ask @two words' })
  expect(result.current.autocomplete.mode).toBe('mention')
  act(() => {
    expect(result.current.handleKey(key('Escape'), 0)).toBe(true)
  })
  // The bots are back for the same `@`, and the text is as typed.
  expect(result.current.autocomplete).toMatchObject({ mode: 'mention', query: '' })
  expect(result.current.mentionFiles.files).toEqual(['Perf bot', 'src/main.ts'])
  expect(completeMention).not.toHaveBeenCalled()
  act(() => result.current.chooseMention('Perf bot'))
  expect(completeMention).toHaveBeenCalledWith('Perf bot', '[Bot: Perf bot](bot:perf)', 4)
})

it('picks the highlighted chat after a spaced filter and uses a plain mention for Home Chat', () => {
  const { result, rerender, completeMention } = mount()
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  expect(completeMention).not.toHaveBeenCalled()
  act(() => {
    expect(result.current.handleKey(key('Enter'), 0)).toBe(true)
  })
  expect(completeMention).toHaveBeenCalledExactlyOnceWith('', '[Bot: Perf bot](bot:perf)', 4)
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  rerender({ draft: 'Ask @two words' })
  act(() => {
    result.current.handleKey(key('ArrowDown'), 0)
  })
  expect(result.current.listed.files).toEqual(['two', 'words'])
  expect(result.current.activeIndex).toBe(1)
  act(() => {
    expect(result.current.handleKey(key('Enter'), 1)).toBe(true)
  })
  expect(completeMention).toHaveBeenLastCalledWith('', '[Bot: Perf bot](bot-chat:perf/words)', 4)
})

it('puts a file picked from the bots, back from a filter with spaces, over the `@` and that filter', () => {
  let draft = 'Ask @'
  const completeMention = (path: string, token?: string, from?: number) => {
    draft = applyNativeChatMention(null, draft, draft.length, path, token, from).draft
  }
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) =>
      useNativeChatComposerMentions(
        undefined,
        text,
        { autocomplete: triggerOf(text), completeMention },
        { terminalTabId: 'tab', structuredWorktreeId: undefined, caret: text.length }
      ),
    { wrapper, initialProps: { text: draft } }
  )
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  draft = 'Ask @two words'
  rerender({ text: draft })
  act(() => {
    result.current.handleKey(key('Escape'), 0)
  })
  act(() => result.current.chooseMention('src/main.ts'))
  expect(draft).toBe('Ask @src/main.ts ')
})
