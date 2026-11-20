// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import type { KeyboardEvent, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import type { ComposerAutocomplete } from '../../../../shared/native-chat/input/composer/native-chat-composer-autocomplete'
import { useNativeChatComposerMentions } from './native-chat-composer-room'
import {
  applyNativeChatMention,
  type NativeChatMentionToken
} from './composer/editor/native-chat-composer-input'
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

it('returns from chat selection without editing the draft and replaces the filter when a file is picked', () => {
  let draft = 'Ask @'
  const completeMention = (path: string, token?: NativeChatMentionToken, from?: number) => {
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
  act(() => {
    expect(result.current.handleKey(key('ArrowLeft'), 0)).toBe(true)
  })
  expect(result.current.mentionFiles.files).toEqual(['Perf bot', 'src/main.ts'])
  expect(draft).toBe('Ask @')
  act(() => {
    result.current.handleKey(key('ArrowRight'), 0)
  })
  draft = 'Ask @two words'
  rerender({ text: draft })
  act(() => {
    expect(result.current.handleKey(key('Escape'), 0)).toBe(true)
  })
  expect(draft).toBe('Ask @two words')
  act(() => result.current.chooseMention('src/main.ts'))
  expect(draft).toBe('Ask @src/main.ts ')
})

const engBots: NativeChatBotChatRoom = {
  withFiles: true,
  mentions: [
    { name: 'Eng - Perf', id: 'perf', key: 'local:perf', icon: null },
    { name: 'Eng - Reviewer', id: 'rev', key: 'local:rev', icon: null },
    { name: 'Eng - Reviewer - Official', id: 'off', key: 'runtime:air:off', icon: null }
  ],
  placeholder: '',
  token: (value) => (value === 'runtime:air:off' ? '[Bot: Official](bot:off@air)' : undefined)
}

function mountSpaced() {
  const completeMention = vi.fn()
  const view = renderHook(
    ({ draft }: { draft: string }) =>
      useNativeChatComposerMentions(
        undefined,
        draft,
        { autocomplete: triggerOf(draft), completeMention },
        { terminalTabId: 'tab', structuredWorktreeId: undefined, caret: draft.length }
      ),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <NativeChatBotChatRoomContext.Provider value={engBots}>
          <NativeChatBotChatPickerContext.Provider value={picker}>
            {children}
          </NativeChatBotChatPickerContext.Provider>
        </NativeChatBotChatRoomContext.Provider>
      ),
      initialProps: { draft: 'notify @eng - reviewer - o' }
    }
  )
  return { ...view, completeMention }
}

it('keeps `@` open past spaces while the words still name a bot, so a later one can be picked', () => {
  const { result, rerender, completeMention } = mountSpaced()
  expect(result.current.autocomplete).toEqual({
    mode: 'mention',
    query: 'eng - reviewer - o',
    triggerKey: '@:7'
  })
  expect(result.current.mentionFiles.files).toEqual(['runtime:air:off', 'src/main.ts'])
  act(() => {
    result.current.chooseMention('runtime:air:off')
  })
  expect(completeMention).toHaveBeenCalledExactlyOnceWith(
    'runtime:air:off',
    '[Bot: Official](bot:off@air)',
    7
  )

  for (const draft of ['notify @eng - reviewer please', 'a@eng - rev', '@- x']) {
    rerender({ draft })
    expect(result.current.autocomplete).toEqual({ mode: 'none' })
  }
  rerender({ draft: 'notify @eng - rev' })
  act(() => {
    expect(result.current.handleKey(key('Escape'), 0)).toBe(true)
  })
  expect(result.current.autocomplete).toEqual({ mode: 'none' })
})

it('keeps a dismissal for the same trigger, then opens a newly typed spaced mention', () => {
  const { result, rerender } = mountSpaced()
  act(() => result.current.handleKey(key('Escape'), 0))
  rerender({ draft: 'notify @eng - rev' })
  expect(result.current.autocomplete).toEqual({ mode: 'none' })
  rerender({ draft: '' })
  rerender({ draft: 'notify @eng - reviewer - o' })
  expect(result.current.autocomplete).toEqual({
    mode: 'mention',
    query: 'eng - reviewer - o',
    triggerKey: '@:7'
  })
})

it('closes after a completed multi-word name and a space while keeping partial names open', () => {
  const { result, rerender } = mountSpaced()
  rerender({ draft: 'notify @eng ' })
  expect(result.current.autocomplete).toEqual({
    mode: 'mention',
    query: 'eng ',
    triggerKey: '@:7'
  })
  rerender({ draft: 'notify @eng - ' })
  expect(result.current.autocomplete).toEqual({
    mode: 'mention',
    query: 'eng - ',
    triggerKey: '@:7'
  })
  rerender({ draft: 'notify @Eng - Reviewer ' })
  expect(result.current.autocomplete).toEqual({ mode: 'none' })
  expect(result.current.handleKey(key('Enter'), 0)).toBe(false)
})

it('returns from a spaced mention chat list on Escape and closes the bots on the next Escape', () => {
  const { result } = mountSpaced()
  act(() => result.current.handleKey(key('ArrowRight'), 0))
  act(() => result.current.handleKey(key('Escape'), 0))
  expect(result.current.autocomplete).toEqual({
    mode: 'mention',
    query: 'eng - reviewer - o',
    triggerKey: '@:7'
  })
  act(() => result.current.handleKey(key('Escape'), 0))
  expect(result.current.autocomplete).toEqual({ mode: 'none' })
})
