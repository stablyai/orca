// @vitest-environment happy-dom
import { createRef } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { NativeChatBotChatChooser } from './NativeChatBotChatChooser'
import {
  NativeChatBotChatPickerContext,
  NativeChatBotMentionTargetContext
} from '../../native-chat-room-context'
import type { NativeChatBotChatPicker } from '../../native-chat-mention-chats'
import { botMentionToken } from '../../../../../../shared/bots/bot-mention-context'

afterEach(cleanup)

const PERF = { id: 'perf', name: 'Perf bot' }
const TITLES: Record<string, string> = { notes: 'Release notes', relay: 'Relay audit' }
const picker: NativeChatBotChatPicker = {
  offers: () => true,
  selfId: null,
  watch: () => {},
  prefetch: () => {},
  view: () => {},
  shown: {
    botId: PERF.id,
    name: PERF.name,
    avatar: null,
    chats: {
      status: 'ready',
      chats: ['notes', 'relay'].map((id) => ({
        id,
        title: TITLES[id] ?? id,
        search: '',
        icon: null,
        line: '',
        time: null,
        plain: false
      }))
    }
  },
  retry: () => {},
  token: () => '',
  pick: () => ({ state: 'ok' }),
  title: (_bot, chat) => TITLES[chat] ?? null
}
const target = () => ({ name: PERF.name, avatar: null, paused: false })

it('reads each chat pill with its chat, so two chats of one bot sound apart', async () => {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatBotMentionTargetContext.Provider value={target}>
      <NativeChatBotChatPickerContext.Provider value={picker}>
        <NativeChatPromptEditor
          inputRef={inputRef}
          initialValue={`ask ${botMentionToken(PERF, 'notes')} and ${botMentionToken(PERF, 'relay')}`}
          disabled={false}
          placeholder="Message"
          onChange={vi.fn()}
          onSelect={vi.fn()}
        />
      </NativeChatBotChatPickerContext.Provider>
    </NativeChatBotMentionTargetContext.Provider>
  )
  await waitFor(() =>
    expect(
      [...view.container.querySelectorAll('[data-native-chat-bot-mention] .sr-only')].map(
        (label) => label.textContent
      )
    ).toEqual([
      'Mentioned bot: Perf bot, chat Release notes',
      'Mentioned bot: Perf bot, chat Relay audit'
    ])
  )
})

it("leaves Shift+Tab to move focus in a pill's chat list; only a plain Tab or Enter picks", () => {
  const onPick = vi.fn()
  render(
    <NativeChatBotChatChooser
      picker={picker}
      botId={PERF.id}
      chatId="notes"
      open
      onOpenChange={() => {}}
      onPick={onPick}
      label="Change chat"
    >
      {(toggle) => toggle}
    </NativeChatBotChatChooser>
  )
  const list = within(document.body).getByRole('listbox', { name: 'Change chat' })
  fireEvent.keyDown(list, { key: 'ArrowDown' })
  fireEvent.keyDown(list, { key: 'Tab', shiftKey: true })
  expect(onPick).not.toHaveBeenCalled()
  fireEvent.keyDown(list, { key: 'Tab' })
  expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'relay' }))
  expect(screen.queryAllByRole('option')).toHaveLength(2)
})
