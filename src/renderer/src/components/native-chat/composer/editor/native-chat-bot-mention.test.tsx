// @vitest-environment happy-dom
import { createRef } from 'react'
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  waitFor,
  within
} from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { useNativeChatPickerState } from '../pickers/use-native-chat-picker-state'
import {
  NativeChatBotMentionTargetContext,
  type NativeChatBotMentionTarget
} from '../../native-chat-room-context'
import { botMentionToken } from '../../../../../../shared/bots/bot-mention-context'
import { agentReferenceNote } from '../../../../../../shared/orchestration/mailbox/orchestration-agent-reference'
import { serializeNativeChatAgentReferences } from '../pickers/native-chat-agent-reference-send'

vi.mock('../pickers/use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({
    status: 'ready',
    skills: [],
    error: null,
    retry: () => {}
  })
}))

afterEach(cleanup)

// What the pill shows, apart from the hidden text a screen reader reads.
const shownName = (pill: Element) => pill.querySelector('.truncate')?.textContent

const NORA = { id: '52fbc8b4-69a9-4cf9-89ef-72499d00c3d7', name: 'Eng - Nora' }
const TOKEN = botMentionToken(NORA)

type Lookup = (id: string) => NativeChatBotMentionTarget | null | undefined
const LISTED = new Map<string, NativeChatBotMentionTarget>([
  [NORA.id, { name: NORA.name, avatar: <img alt="" data-testid="avatar" />, paused: false }],
  ['qa', { name: 'QA Nightly', avatar: null, paused: true }]
])
// The chat's computer has listed its bots: an id not among them is a deleted bot.
const listed: Lookup = (id) => LISTED.get(id) ?? null

function setup(value: string, caret = value.length, lookup: Lookup = listed) {
  const inputRef = createRef<NativeChatComposerInput>()
  const view = render(
    <NativeChatBotMentionTargetContext.Provider value={lookup}>
      <NativeChatPromptEditor
        inputRef={inputRef}
        initialValue={value}
        disabled={false}
        placeholder="Message"
        onChange={vi.fn()}
        onSelect={vi.fn()}
      />
    </NativeChatBotMentionTargetContext.Provider>
  )
  const input = inputRef.current!
  act(() => input.setSelectionRange(caret, caret))
  const pills = () => [...view.container.querySelectorAll('[data-native-chat-bot-mention]')]
  // Pills are React node views, which mount after the transaction that made them.
  const pillNames = async (names: string[]) =>
    waitFor(() => expect(pills().map(shownName)).toEqual(names))
  return {
    ...view,
    input,
    inputRef,
    pills,
    pillNames,
    editor: promptEditor(within(view.container).getByRole('textbox'))
  }
}

function pick(
  inputRef: React.RefObject<NativeChatComposerInput | null>,
  draft: string,
  { name = NORA.name, token = TOKEN, composing = false } = {}
) {
  const input = inputRef.current!
  const { result } = renderHook(() =>
    useNativeChatPickerState({
      agent: 'claude',
      terminalTabId: 'tab-1',
      draftScopeKey: 'pane-1',
      draft,
      caret: input.selectionStart ?? draft.length,
      agentCommands: [],
      recalledFromHistory: false,
      disabled: false,
      isComposing: () => composing,
      textareaRef: inputRef,
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn()
    })
  )
  expect(result.current.autocomplete.mode).toBe('mention')
  act(() => result.current.completeMention(name, token))
}

it('inserts a picked bot as one undoable pill and preserves the surrounding draft', async () => {
  const draft = 'ask @Eng to review'
  const { input, inputRef, pills, pillNames, getByTestId, editor } = setup(draft, 'ask @Eng'.length)
  pick(inputRef, draft)

  await pillNames([NORA.name])
  expect(pills()[0].getAttribute('data-native-chat-bot-mention')).toBe(NORA.id)
  expect(getByTestId('avatar')).toBeTruthy()
  expect(input.value).toBe(`ask ${TOKEN} to review`)
  expect(input.selectionStart).toBe(`ask ${TOKEN} `.length)
  act(() => {
    editor.commands.undo()
  })
  expect(input.value).toBe(draft)
  await pillNames([])
  expect(pills()).toEqual([])
})

it("shows a deleted bot dimmed, saying the message won't reach it", async () => {
  const { pills, pillNames } = setup(`ask ${botMentionToken({ id: 'gone', name: 'Old bot' })}`)
  await pillNames(['Old bot'])
  const [pill] = pills()
  expect(pill.getAttribute('data-bot-state')).toBe('missing')
  expect(pill.querySelector('[data-muted]')).toBeTruthy()
  expect(pill.querySelector('[title]')?.getAttribute('title')).toBe(
    "Old bot: This bot no longer exists; this message won't reach it"
  )
  expect(pill.querySelector('.sr-only')?.textContent).toBe(
    'Mentioned bot: Old bot, no longer exists'
  )
  expect(pill.querySelector('svg')).toBeTruthy()
})

it('shows a paused bot dimmed, saying it is paused', async () => {
  const { pills, pillNames } = setup(`ask ${botMentionToken({ id: 'qa', name: 'QA Nightly' })}`)
  await pillNames(['QA Nightly'])
  expect(pills()[0].getAttribute('data-bot-state')).toBe('paused')
  expect(pills()[0].querySelector('[data-muted]')).toBeTruthy()
  expect(pills()[0].querySelector('[title]')?.getAttribute('title')).toBe('QA Nightly: Paused')
  expect(pills()[0].querySelector('.sr-only')?.textContent).toBe(
    'Mentioned bot: QA Nightly, paused'
  )
})

it('shows a renamed bot by its current name; the sent token keeps the id it was picked by', async () => {
  const stale = botMentionToken({ id: NORA.id, name: 'Nora (old name)' })
  const { input, pills, pillNames } = setup(`ask ${stale}`)
  await pillNames([NORA.name])
  expect(pills()[0].querySelector('[data-muted]')).toBeNull()
  expect(input.value).toBe(`ask ${stale}`)
})

it("shows the picked name, not muted, until the chat's computer has listed its bots", async () => {
  const { pills, pillNames } = setup(
    `ask ${botMentionToken({ id: 'gone', name: 'Old bot' })}`,
    undefined,
    () => undefined
  )
  await pillNames(['Old bot'])
  expect(pills()[0].getAttribute('data-bot-state')).toBeNull()
  expect(pills()[0].querySelector('[data-muted]')).toBeNull()
  expect(pills()[0].querySelector('[title]')?.getAttribute('title')).toBe('Old bot')
})

it('tells a screen reader it is a mentioned bot, hiding what it shows', async () => {
  const { pills, pillNames } = setup(`ask ${TOKEN}`)
  await pillNames([NORA.name])
  const [pill] = pills()
  expect(pill.querySelector('.sr-only')?.textContent).toBe(`Mentioned bot: ${NORA.name}`)
  expect(pill.querySelector('.truncate')?.getAttribute('aria-hidden')).toBe('true')
  expect(pill.querySelector('[data-testid="avatar"]')?.closest('[aria-hidden="true"]')).toBeTruthy()
})

it('rebuilds the pill from its token when the draft is pasted, restored or rewritten', async () => {
  const { input, pillNames, editor } = setup('hi ')
  const clipboardData = {
    getData: (type: string) => (type === 'text/plain' ? TOKEN : '')
  }
  act(() => {
    fireEvent.paste(editor.view.dom, { clipboardData })
  })
  await pillNames([NORA.name])
  expect(input.value).toBe(`hi ${TOKEN}`)

  act(() => {
    input.value = `${TOKEN} and ${botMentionToken({ id: 'x', name: 'QA [nightly]' })}`
  })
  await pillNames([NORA.name, 'QA [nightly]'])
  expect(input.value).toBe(`${TOKEN} and [Bot: QA \\[nightly\\]](bot:x)`)
})

it('copies a picked bot as the same token in plain text and HTML, so either can be pasted back', () => {
  const { editor } = setup(`ask ${TOKEN} now`)
  const { text, dom } = editor.view.serializeForClipboard(
    editor.state.doc.slice(1, editor.state.doc.content.size - 1)
  )
  expect(text).toBe('ask [Bot: Eng - Nora](bot:52fbc8b4-69a9-4cf9-89ef-72499d00c3d7) now')
  expect(dom.textContent).toBe(
    'ask [Bot: Eng - Nora](bot:52fbc8b4-69a9-4cf9-89ef-72499d00c3d7) now'
  )
})

it('keeps the text after the caret when picking from the middle of the query', async () => {
  const { input, inputRef, pillNames } = setup('ask @Ne il', 'ask @Ne'.length)
  pick(inputRef, 'ask @Ne il')
  await pillNames([NORA.name])
  expect(input.value).toBe(`ask ${TOKEN} il`)
})

it('round-trips a bot name with a backslash through the pick', async () => {
  const name = 'a\\b'
  const token = botMentionToken({ id: 'slash', name })
  const { input, inputRef, pillNames } = setup('@a')
  pick(inputRef, '@a', { name, token })
  await pillNames([name])
  expect(input.value).toBe(`${token} `)
})

it("keeps a group room's `@Name` plain text, its own undo step all the same", async () => {
  const { input, inputRef, pills, editor } = setup('ask @Sc')
  pick(inputRef, 'ask @Sc', { name: 'Scout', token: '@Scout' })
  expect(input.value).toBe('ask @Scout ')
  expect(pills()).toEqual([])
  act(() => {
    editor.commands.undo()
  })
  expect(input.value).toBe('ask @Sc')
})

it('leaves the document alone while an IME composition owns it', () => {
  const { input, inputRef, pills, editor } = setup('ask @Eng')
  Object.defineProperty(editor.view, 'composing', { configurable: true, get: () => true })
  try {
    pick(inputRef, 'ask @Eng', { composing: true })
    expect(input.value).toBe('ask @Eng')
    expect(pills()).toEqual([])
  } finally {
    // Back to ProseMirror's own getter.
    Reflect.deleteProperty(editor.view, 'composing')
  }
})

it('sends agent references next to a picked bot, the bot as its token', async () => {
  const { input, editor } = setup(`ask ${TOKEN} and `)
  act(() => input.setSelectionRange(input.value.length, input.value.length))
  act(() =>
    input.insertAgentReferences?.([{ label: 'Worker', address: 'term_abc', hostKey: 'local' }])
  )
  const sent = serializeNativeChatAgentReferences(input.value, editor.getJSON())
  expect(sent).toContain(`ask ${TOKEN} and `)
  expect(sent).toContain(agentReferenceNote('Worker', 'term_abc'))
})
