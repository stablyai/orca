// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatComposerKeyDown } from '../editor/use-native-chat-composer-keydown'
import {
  NATIVE_CHAT_REPLY_TARGETS_MAX,
  readNativeChatReplyTarget,
  resetNativeChatReplyTargetsForTests,
  nativeChatReplyTargetFromSentText,
  cancelNativeChatReplyTarget,
  restoreNativeChatReplyTarget,
  nativeChatReplyCustody,
  settleNativeChatReplySend,
  setNativeChatReplyTarget,
  useNativeChatReplyTarget
} from './native-chat-reply-target'
import { nativeChatReplyOriginalId } from './native-chat-reply-original'
import { nativeChatReplyDisplayText } from './NativeChatReplyQuoteChip'
import { translate } from '@/i18n/i18n'
import {
  nativeChatReplyExcerpt,
  nativeChatReplyQuoteOf,
  withNativeChatReplyContext
} from './native-chat-reply-quote'
import { readNativeChatContextMenuTarget } from '../../pane/actions/native-chat-context-menu-target'
import { NativeChatReplyStrip } from './NativeChatReplyStrip'
import {
  deleteNativeChatComposerDraft,
  deleteNativeChatComposerDraftsOwnedBy
} from '../../drafts/native-chat-composer-draft-removal'
import { registerNativeChatComposerDestination } from '../focus/native-chat-composer-destination'
import type { NativeChatComposerHandle } from '../native-chat-composer-types'
import {
  requestNativeChatMessageReveal,
  startNativeChatReply,
  useNativeChatMessageRevealAnswer
} from './native-chat-reply-context'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
import { readNativeChatComposerDraft } from '../../drafts/native-chat-composer-draft-store'
import { returnMessageToComposer } from '../../session/structured/delivery/structured-agent-session-message-hand-back'

const text = (value: string) => ({ type: 'text' as const, text: value })

const reply = (id: string, messageId = 'm-1') => ({
  id,
  messageId,
  author: 'agent' as const,
  excerpt: 'Updated the three cards.'
})

beforeEach(() => {
  localStorage.clear()
  resetNativeChatReplyTargetsForTests()
  clearNativeChatComposerDraftsForTests()
})
afterEach(() => cleanup())

describe('reply targets', () => {
  it('tells a mounted chat when its reply is dropped to make room for newer ones', () => {
    setNativeChatReplyTarget('scope-old', reply('old'))
    const mounted = renderHook(() => useNativeChatReplyTarget('scope-old'))
    expect(mounted.result.current?.id).toBe('old')
    act(() => {
      for (let index = 0; index < NATIVE_CHAT_REPLY_TARGETS_MAX; index += 1) {
        setNativeChatReplyTarget(`scope-${index}`, reply(`r-${index}`))
      }
    })
    expect(mounted.result.current).toBeNull()
    expect(readNativeChatReplyTarget('scope-old')).toBeNull()
  })

  it('forgets a reply when its chat draft is deleted', () => {
    setNativeChatReplyTarget('agent-session:gone', reply('r'))
    setNativeChatReplyTarget('agent-session:kept', reply('k'))
    deleteNativeChatComposerDraft('agent-session:gone')
    expect(readNativeChatReplyTarget('agent-session:gone')).toBeNull()
    expect(readNativeChatReplyTarget('agent-session:kept')?.id).toBe('k')
  })
})

const interrupt = vi.fn()
const dismissPicker = vi.fn()

function Input({ pickerOpen }: { pickerOpen: boolean }): React.JSX.Element {
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: pickerOpen ? { mode: 'mention', query: '', triggerKey: '@' } : { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: () => {},
    activeSuggestion: 0,
    draft: '',
    isComposing: () => false,
    completePickerItem: () => {},
    dispatchPickerCommand: () => {},
    dismissPicker,
    interrupt,
    send: () => {},
    setActiveSuggestion: () => {},
    setDraft: () => {},
    setCaret: () => {}
  })
  return <div contentEditable data-testid="input" onKeyDown={onKeyDown} />
}

const NONE_UNDRAWN: readonly string[] = []

function Transcript({
  messages,
  undrawn = NONE_UNDRAWN
}: {
  messages: readonly string[]
  /** Loaded but not yet drawn, as a row far off screen. */
  undrawn?: readonly string[]
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  useNativeChatMessageRevealAnswer(scrollRef, ({ messageId }) =>
    messages.includes(messageId) || undrawn.includes(messageId) ? messageId : null
  )
  return (
    <div ref={scrollRef}>
      {messages.map((id) => (
        <div key={id} data-native-chat-message-id={id}>
          {id}
        </div>
      ))}
    </div>
  )
}

function Chat({
  messages,
  undrawn,
  pickerOpen = false,
  transcript = true
}: {
  messages: readonly string[]
  undrawn?: readonly string[]
  pickerOpen?: boolean
  transcript?: boolean
}): React.JSX.Element {
  return (
    <div data-native-chat-root="true">
      {transcript ? <Transcript messages={messages} undrawn={undrawn} /> : null}
      <div data-native-chat-composer-scope="scope">
        <NativeChatReplyStrip scopeKey="scope" agent="claude" onDone={() => {}} />
        <Input pickerOpen={pickerOpen} />
      </div>
    </div>
  )
}

describe('reply strip', () => {
  it('follows the original as the transcript loses and regains it', () => {
    setNativeChatReplyTarget('scope', reply('r', 'm-7'))
    const view = render(<Chat messages={['m-7']} />)
    expect(screen.queryByText('Message unavailable')).toBeNull()
    view.rerender(<Chat messages={[]} />)
    expect(screen.getByText('Message unavailable')).toBeTruthy()
    view.rerender(<Chat messages={['m-7']} />)
    expect(screen.queryByText('Message unavailable')).toBeNull()
  })

  it('lets an open picker take Esc first, then Esc cancels the reply and says so', async () => {
    setNativeChatReplyTarget('scope', reply('r', 'm-7'))
    const view = render(<Chat messages={['m-7']} pickerOpen />)
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Replying to Claude')
    )
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Escape' })
    expect(dismissPicker).toHaveBeenCalledTimes(1)
    expect(readNativeChatReplyTarget('scope')?.id).toBe('r')
    view.rerender(<Chat messages={['m-7']} />)
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Escape' })
    expect(readNativeChatReplyTarget('scope')).toBeNull()
    expect(interrupt).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(screen.getByRole('status').textContent).toBe('Reply cancelled'))
    // With no reply left, Esc interrupts the agent as before.
    fireEvent.keyDown(screen.getByTestId('input'), { key: 'Escape' })
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('outlines the original; keyboard activation also moves focus there, a click keeps it', () => {
    setNativeChatReplyTarget('scope', reply('r', 'm-7'))
    render(<Chat messages={['m-7']} />)
    const jump = screen.getByRole('button', { name: /Show the original message/ })
    const row = screen.getByText('m-7')
    jump.focus()
    fireEvent.click(jump, { detail: 1 })
    expect(row.hasAttribute('data-native-chat-reply-landed')).toBe(true)
    expect(document.activeElement).toBe(jump)
    fireEvent.click(jump, { detail: 0 })
    expect(document.activeElement).toBe(row)
  })

  it('an earlier jump still waiting for its row does not take focus from a later one', () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
      frames.push(frame)
      return frames.length
    })
    const view = render(<Chat messages={['m-b']} undrawn={['m-a']} />)
    const from = screen.getByTestId('input')
    const message = (messageId: string) => ({ messageId, author: 'agent' as const, excerpt: '' })
    requestNativeChatMessageReveal(from, message('m-a'), { probe: false, focus: true })
    requestNativeChatMessageReveal(from, message('m-b'), { probe: false, focus: true })
    expect(document.activeElement).toBe(screen.getByText('m-b'))
    view.rerender(<Chat messages={['m-a', 'm-b']} />)
    // The earlier jump's next frame finds its row drawn now.
    for (const frame of frames.splice(0)) {
      frame(0)
    }
    expect(document.activeElement).toBe(screen.getByText('m-b'))
    raf.mockRestore()
  })

  it('names your own message as a whole sentence', async () => {
    setNativeChatReplyTarget('scope', { ...reply('r', 'm-7'), author: 'user' })
    render(<Chat messages={['m-7']} />)
    expect(screen.getByRole('group', { name: 'Replying to your message' })).toBeTruthy()
    await vi.waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('Replying to your message')
    )
  })
})

describe('reply quotes', () => {
  it('reads a sent reply back for the compact line and keeps only its own words for a new excerpt', () => {
    const sent = withNativeChatReplyContext(
      'Why blue?',
      { author: 'agent', excerpt: 'Updated the cards.' },
      'Claude'
    )
    expect(nativeChatReplyQuoteOf(sent)).toEqual({
      author: 'agent',
      label: 'Claude',
      excerpt: 'Updated the cards.',
      rest: 'Why blue?'
    })
    expect(nativeChatReplyExcerpt(sent)).toBe('Why blue?')
    expect(nativeChatReplyExcerpt('## Plan\n```ts\nconst a = 1\n```')).toBe('Plan\nconst a = 1')
  })

  it('offers no Reply for a message inside a subagent view', () => {
    const view = document.createElement('div')
    view.setAttribute('data-native-chat-subagent-view', 'agent-1')
    const row = document.createElement('div')
    row.setAttribute('data-native-chat-message-id', 'm-1')
    row.setAttribute('data-native-chat-message-author', 'agent')
    view.append(row)
    document.body.append(view)
    const target = readNativeChatContextMenuTarget(row, {
      root: view,
      composer: null,
      messageList: { messageCopyText: () => 'words' },
      linkContext: null
    })
    expect(target.replyTo).toBeNull()
    view.remove()
  })

  it('splits a sent reply back into the words and a reply that finds its original by those words', () => {
    const sent = withNativeChatReplyContext(
      'Why blue?',
      { author: 'agent', excerpt: 'Updated the cards.' },
      'Claude'
    )
    const { rest, target } = nativeChatReplyTargetFromSentText(sent)
    expect(rest).toBe('Why blue?')
    expect(target).toMatchObject({
      messageId: '',
      author: 'agent',
      agentLabel: 'Claude',
      excerpt: 'Updated the cards.'
    })
    // Sent again unchanged, it keeps the agent it was written for.
    expect(withNativeChatReplyContext(rest, target, 'Codex')).toBe(sent)
    // The user's own indentation survives the round trip.
    const code = withNativeChatReplyContext('    first()\n    second()', target, 'Codex')
    expect(nativeChatReplyTargetFromSentText(code).rest).toBe('    first()\n    second()')
  })

  it('finds a restored reply by its author and own words, never a reply bubble quoting it', () => {
    const original = { id: 'm1', role: 'assistant' as const, blocks: [text('Turn 47 notes.')] }
    const quoting = {
      id: 'm2',
      role: 'user' as const,
      blocks: [
        text(
          withNativeChatReplyContext(
            'Keep it?',
            { author: 'agent', excerpt: 'Turn 47 notes.' },
            'Claude'
          )
        )
      ]
    }
    const restored = { author: 'agent' as const, excerpt: 'Turn 47 notes.' }
    expect(nativeChatReplyOriginalId([original, quoting], restored)).toBe('m1')
    expect(nativeChatReplyOriginalId([quoting], restored)).toBeNull()
    // A short excerpt is the whole message, not any message containing it.
    const longer = {
      id: 'm3',
      role: 'assistant' as const,
      blocks: [text('Done. Next I will fix it.')]
    }
    expect(nativeChatReplyOriginalId([longer], { author: 'agent', excerpt: 'Done.' })).toBeNull()
  })

  it('shows the whole quote when a queued card is expanded', () => {
    const sent = withNativeChatReplyContext(
      'Why?',
      { author: 'agent', excerpt: 'First line.\nSecond line.' },
      'Claude'
    )
    expect(nativeChatReplyDisplayText(sent, translate, true)).toContain('Second line.')
  })
})

describe('restored replies', () => {
  it('a refused send does not bring its reply back after the user picked and cancelled another', () => {
    setNativeChatReplyTarget('scope', reply('a'))
    settleNativeChatReplySend('scope', 'a')
    const takenAt = nativeChatReplyCustody('scope')
    setNativeChatReplyTarget('scope', reply('b'))
    cancelNativeChatReplyTarget('scope')
    expect(restoreNativeChatReplyTarget('scope', reply('a'), takenAt)).toBe(false)
    expect(readNativeChatReplyTarget('scope')).toBeNull()
  })

  it('a rewound reply gets its strip back after an earlier cancel and a plain send', () => {
    setNativeChatReplyTarget('agent-session:rw', reply('r'))
    cancelNativeChatReplyTarget('agent-session:rw')
    settleNativeChatReplySend('agent-session:rw')
    returnMessageToComposer('agent-session:rw', 'rw', [
      text(withNativeChatReplyContext('Why blue?', { author: 'agent', excerpt: 'Old.' }, 'Claude'))
    ])
    expect(readNativeChatComposerDraft('agent-session:rw').text).toBe('Why blue?')
    expect(readNativeChatReplyTarget('agent-session:rw')?.excerpt).toBe('Old.')
  })

  it('a rewound reply keeps its quote as text when the box already answers another message', () => {
    setNativeChatReplyTarget('agent-session:busy', reply('open'))
    const sent = withNativeChatReplyContext('Why?', { author: 'agent', excerpt: 'Old.' }, 'Claude')
    returnMessageToComposer('agent-session:busy', 'rw', [text(sent)])
    expect(readNativeChatComposerDraft('agent-session:busy').text).toBe(sent)
    expect(readNativeChatReplyTarget('agent-session:busy')?.id).toBe('open')
  })

  it('a send in flight cannot bring its reply back once its workspace is removed', () => {
    const owner = { workspaceId: 'ws-2', executionHostId: 'local' } as const
    setNativeChatReplyTarget('agent-session:pending', { ...reply('r'), owner })
    settleNativeChatReplySend('agent-session:pending', 'r')
    const takenAt = nativeChatReplyCustody('agent-session:pending')
    deleteNativeChatComposerDraftsOwnedBy(owner)
    restoreNativeChatReplyTarget('agent-session:pending', reply('r'), takenAt)
    expect(readNativeChatReplyTarget('agent-session:pending')).toBeNull()
  })

  it('a rewound reply comes back as the user words with its reply strip', () => {
    returnMessageToComposer('agent-session:rewound', 'rw', [
      {
        type: 'text',
        text: withNativeChatReplyContext(
          'Why blue?',
          { author: 'agent', excerpt: 'Updated the cards.' },
          'Claude'
        )
      }
    ])
    expect(readNativeChatComposerDraft('agent-session:rewound').text).toBe('Why blue?')
    expect(readNativeChatReplyTarget('agent-session:rewound')?.excerpt).toBe('Updated the cards.')
  })

  it('forgets a reply-only chat when its workspace is removed, with no draft text', () => {
    const owner = { workspaceId: 'ws-1', executionHostId: 'local' } as const
    setNativeChatReplyTarget('agent-session:closed', { ...reply('r'), owner })
    deleteNativeChatComposerDraftsOwnedBy(owner)
    expect(readNativeChatReplyTarget('agent-session:closed')).toBeNull()
  })
})

describe('where Reply goes', () => {
  function registered(primary: boolean, scope: string): HTMLElement {
    const root = document.createElement('div')
    root.setAttribute('data-native-chat-root', 'true')
    const box = document.createElement('div')
    root.append(box)
    document.body.append(root)
    const composer: NativeChatComposerHandle = {
      insertAgentReferences: () => false,
      focus: () => true,
      insertTypedText: () => false,
      acceptsText: () => true,
      appendText: () => {},
      handlePasteEvent: () => {},
      pasteFromClipboard: () => {},
      contains: () => false
    }
    const handle = { current: composer }
    registerNativeChatComposerDestination(box, handle, primary, scope)
    return root
  }

  it('picks the chat message box and never a queued-message editor', () => {
    const onlyEditor = registered(false, 'queued-edit:1')
    expect(
      startNativeChatReply(onlyEditor, { messageId: 'm-1', author: 'agent', text: 'Hi' })
    ).toBe(false)
    expect(readNativeChatReplyTarget('queued-edit:1')).toBeNull()
    const chat = registered(true, 'agent-session:main')
    expect(startNativeChatReply(chat, { messageId: 'm-1', author: 'agent', text: 'Hi' })).toBe(true)
    expect(readNativeChatReplyTarget('agent-session:main')?.messageId).toBe('m-1')
    onlyEditor.remove()
    chat.remove()
  })
})

describe('reply strip without a transcript', () => {
  it('shows the original as unavailable once the transcript goes away', () => {
    setNativeChatReplyTarget('scope', reply('r', 'm-7'))
    const view = render(<Chat messages={['m-7']} />)
    expect(screen.queryByText('Message unavailable')).toBeNull()
    view.rerender(<Chat messages={['m-7']} transcript={false} />)
    expect(screen.getByText('Message unavailable')).toBeTruthy()
  })
})
