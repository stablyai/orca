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
import {
  rememberNativeChatReplySource,
  resetNativeChatReplySourcesForTests
} from './native-chat-reply-sources'
import { setNativeChatComposerDraftOwnerResolver } from '../../drafts/native-chat-composer-draft-memory'
import {
  NATIVE_CHAT_REPLY_EXCERPT_MAX,
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
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
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
  resetNativeChatReplySourcesForTests()
  setNativeChatComposerDraftOwnerResolver(() => undefined)
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

  it('a second jump to the same message keeps its outline for the full time', () => {
    vi.useFakeTimers()
    try {
      render(<Chat messages={['m-7']} />)
      const from = screen.getByTestId('input')
      const row = screen.getByText('m-7')
      const jump = () =>
        requestNativeChatMessageReveal(
          from,
          { messageId: 'm-7', author: 'agent', excerpt: '' },
          { probe: false }
        )
      jump()
      vi.advanceTimersByTime(1000)
      jump()
      vi.advanceTimersByTime(1000)
      expect(row.hasAttribute('data-native-chat-reply-landed')).toBe(true)
      vi.advanceTimersByTime(600)
      expect(row.hasAttribute('data-native-chat-reply-landed')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
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
    const { rest, target } = nativeChatReplyTargetFromSentText(sent, 'chat-a')
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
    expect(nativeChatReplyTargetFromSentText(code, 'chat-a').rest).toBe('    first()\n    second()')
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
    // A message that itself ends in "…" was not cut, so a later one starting with it is no match.
    const trailing = { id: 'm4', role: 'assistant' as const, blocks: [text('Done…')] }
    const later = { id: 'm5', role: 'assistant' as const, blocks: [text('Done… Next step.')] }
    expect(
      nativeChatReplyOriginalId([trailing, later], { author: 'agent', excerpt: 'Done…' })
    ).toBe('m4')
  })

  it('a reply rebuilt from text this client sent keeps the exact original among identical messages', () => {
    const sent = withNativeChatReplyContext(
      'Which one?',
      { author: 'agent', excerpt: 'Done.' },
      'Claude'
    )
    rememberNativeChatReplySource('chat-a', sent, 'm-first')
    expect(nativeChatReplyTargetFromSentText(sent, 'chat-a').target?.messageId).toBe('m-first')
    // Without that record two identical messages can't be told apart: the original is unavailable.
    const done = (id: string) => ({ id, role: 'assistant' as const, blocks: [text('Done.')] })
    expect(
      nativeChatReplyOriginalId([done('m-first'), done('m-second')], {
        author: 'agent',
        excerpt: 'Done.'
      })
    ).toBeNull()
  })

  it('cuts an excerpt within the cap on a whole character, and matches only the message that gives it', () => {
    const cut = nativeChatReplyExcerpt(`${'a'.repeat(498)}😀 and the rest`)
    expect(Array.from(cut)).toHaveLength(NATIVE_CHAT_REPLY_EXCERPT_MAX)
    expect(cut.endsWith('😀…')).toBe(true)
    // Cut where a space falls, the original keeps only its first 498 characters; a longer message
    // starting with those same characters gives a different excerpt and is not the original.
    const shared = 'a'.repeat(498)
    const filler = ' more'.repeat(20)
    const original = {
      id: 'm-orig',
      role: 'assistant' as const,
      blocks: [text(`${shared} x${filler}`)]
    }
    const other = {
      id: 'm-other',
      role: 'assistant' as const,
      blocks: [text(`${shared}B${filler}`)]
    }
    const excerpt = nativeChatReplyExcerpt(`${shared} x${filler}`)
    expect(nativeChatReplyOriginalId([other], { author: 'agent', excerpt })).toBeNull()
    expect(nativeChatReplyOriginalId([original, other], { author: 'agent', excerpt })).toBe(
      'm-orig'
    )
  })

  it('reads text as a reply only with a quote line, and keeps the words exactly as typed', () => {
    expect(nativeChatReplyQuoteOf('> Replying to my earlier message:\n\nWhy?')).toBeNull()
    const empty = withNativeChatReplyContext('Why?', { author: 'user', excerpt: '' }, 'Claude')
    expect(nativeChatReplyQuoteOf(empty)?.rest).toBe('Why?')
    const crlf = withNativeChatReplyContext(
      'first\r\nsecond',
      { author: 'user', excerpt: 'Old.' },
      'Claude'
    )
    expect(nativeChatReplyQuoteOf(crlf)?.rest).toBe('first\r\nsecond')
  })

  it('cuts at the cap even with no space to trim, leaving room for the ellipsis', () => {
    expect(Array.from(nativeChatReplyExcerpt('b'.repeat(600)))).toHaveLength(
      NATIVE_CHAT_REPLY_EXCERPT_MAX
    )
  })

  it('finds a long agent message made of several text blocks, as the Reply action read it', () => {
    const blocks = [text(`${'First part. '.repeat(30)}`), text(`${'Second part. '.repeat(30)}`)]
    // Reply reads a row's text blocks a blank line apart.
    const excerpt = nativeChatReplyExcerpt(blocks.map((block) => block.text).join('\n\n'))
    const message = { id: 'm-blocks', role: 'assistant' as const, blocks }
    expect(nativeChatReplyOriginalId([message], { author: 'agent', excerpt })).toBe('m-blocks')
  })

  it('a long excerpt of wide characters survives a reload whole', () => {
    const excerpt = `${'😀'.repeat(NATIVE_CHAT_REPLY_EXCERPT_MAX - 1)}…`
    setNativeChatReplyTarget('scope-wide', { ...reply('r'), excerpt })
    resetNativeChatReplyTargetsForTests()
    expect(readNativeChatReplyTarget('scope-wide')?.excerpt).toBe(excerpt)
  })

  it('a long message cut to an excerpt is still found by what was kept', () => {
    const long = `${'Updated the layout. '.repeat(40)}Done.`
    const excerpt = nativeChatReplyExcerpt(long)
    expect(excerpt.endsWith('…')).toBe(true)
    const message = { id: 'm-long', role: 'assistant' as const, blocks: [text(long)] }
    expect(nativeChatReplyOriginalId([message], { author: 'agent', excerpt })).toBe('m-long')
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

  it('a reply remembered from before a reload is still fenced when its workspace is removed', () => {
    const owner = { workspaceId: 'ws-3', executionHostId: 'local' } as const
    setNativeChatReplyTarget('agent-session:reloaded', { ...reply('r'), owner })
    resetNativeChatReplyTargetsForTests()
    settleNativeChatReplySend('agent-session:reloaded', 'r')
    const takenAt = nativeChatReplyCustody('agent-session:reloaded')
    deleteNativeChatComposerDraftsOwnedBy(owner)
    expect(restoreNativeChatReplyTarget('agent-session:reloaded', reply('r'), takenAt)).toBe(false)
  })

  it('a reply remembered from before a reload is fenced when its own chat is deleted, and returns otherwise', () => {
    setNativeChatReplyTarget('agent-session:gone', reply('g'))
    setNativeChatReplyTarget('agent-session:kept', reply('k'))
    resetNativeChatReplyTargetsForTests()
    settleNativeChatReplySend('agent-session:gone', 'g')
    settleNativeChatReplySend('agent-session:kept', 'k')
    const goneAt = nativeChatReplyCustody('agent-session:gone')
    const keptAt = nativeChatReplyCustody('agent-session:kept')
    deleteNativeChatComposerDraft('agent-session:gone')
    expect(restoreNativeChatReplyTarget('agent-session:gone', reply('g'), goneAt)).toBe(false)
    expect(restoreNativeChatReplyTarget('agent-session:kept', reply('k'), keptAt)).toBe(true)
  })

  it('a reply rebuilt from sent text belongs to its chat’s workspace, active or taken by a send', () => {
    const owner = { workspaceId: 'ws-4', executionHostId: 'local' } as const
    setNativeChatComposerDraftOwnerResolver((scope) => (scope.endsWith('-ws4') ? owner : undefined))
    const sent = withNativeChatReplyContext('Why?', { author: 'agent', excerpt: 'Old.' }, 'Claude')
    returnMessageToComposer('agent-session:active-ws4', 'rw', [text(sent)])
    returnMessageToComposer('agent-session:pending-ws4', 'rw', [text(sent)])
    // The words are cleared, so nothing but the reply itself still names the workspace.
    for (const scope of ['agent-session:active-ws4', 'agent-session:pending-ws4']) {
      updateNativeChatComposerDraft(
        scope,
        { text: '', document: undefined, images: [] },
        'immediate'
      )
    }
    const pending = readNativeChatReplyTarget('agent-session:pending-ws4')
    settleNativeChatReplySend('agent-session:pending-ws4', pending?.id)
    const takenAt = nativeChatReplyCustody('agent-session:pending-ws4')
    deleteNativeChatComposerDraftsOwnedBy(owner)
    expect(readNativeChatReplyTarget('agent-session:active-ws4')).toBeNull()
    expect(
      restoreNativeChatReplyTarget('agent-session:pending-ws4', pending ?? reply('x'), takenAt)
    ).toBe(false)
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

  it('does nothing while a question card hides the message box', () => {
    const chat = registered(true, 'agent-session:hidden')
    chat.firstElementChild?.setAttribute('hidden', '')
    expect(startNativeChatReply(chat, { messageId: 'm-1', author: 'agent', text: 'Hi' })).toBe(
      false
    )
    expect(readNativeChatReplyTarget('agent-session:hidden')).toBeNull()
    chat.remove()
  })

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
