// @vitest-environment happy-dom
import { useCallback, useRef, useState } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-quote-highlight', () => ({ showQuotedText: shown }))

import type { NativeChatOlderPageResult } from '../viewport/history/native-chat-pagination'
import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from '../viewport/navigation/use-native-chat-transcript-navigation'
import {
  jumpToQuoteSource,
  rememberNativeChatQuoteSource,
  type QuoteSource
} from './native-chat-quote-sources'
import type { NativeChatQuoteJump } from './use-native-chat-quote-jump'

afterEach(() => {
  cleanup()
  shown.mockReset()
  localStorage.clear()
})

const none = () => {}
const CHAT = 'claude:session-1'

function slot(id: string): NativeChatTranscriptSlot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation reads only each slot's kind and message id.
  return { kind: 'message', message: { id } } as unknown as NativeChatTranscriptSlot
}

type Page = string | Promise<string>

/**
 * A long chat: the quoted reply is in older history, which a send to the end trimmed away. Each
 * page is a message id, 'superseded' (a page of an earlier read), or a promise of a message id.
 */
function Transcript({
  pages,
  onJump,
  spies
}: {
  pages: Page[]
  onJump: (jump: NativeChatQuoteJump) => void
  spies: { holdHistory: () => void; readerLeavesEnd: () => void; loadEarlier: () => void }
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState(() => ['latest-0', 'latest-1'].map(slot))
  const queue = useRef([...pages])
  const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
    spies.loadEarlier()
    const page = await queue.current.shift()
    if (page === undefined) {
      return 'exhausted'
    }
    if (page === 'superseded') {
      return 'superseded'
    }
    setSlots((current) => [slot(page), ...current])
    return 'applied'
  }, [spies])
  const request = useNativeChatNavigationRequest(slots)
  const { jumpToQuote } = useNativeChatNavigation({
    request,
    rail: { items: [], onActivate: none },
    slots,
    conversation: [],
    subagentRows: new Map(),
    roster: undefined,
    journalItems: [],
    subagentId: null,
    sessionKey: CHAT,
    sessionId: 'session-1',
    isVisible: true,
    loadEarlier,
    holdHistory: spies.holdHistory,
    releaseHistory: none,
    scrollRef,
    scrollMessageToTop: none,
    readerLeavesEnd: spies.readerLeavesEnd,
    scrollToBottom: none
  })
  onJump(jumpToQuote)
  return (
    <div ref={scrollRef}>
      {slots.map((row, index) => (
        <div key={index} data-index={index}>
          <div data-native-chat-quote-source={row.kind === 'message' ? row.message.id : ''}>
            The quoted text.
          </div>
        </div>
      ))}
    </div>
  )
}

function chat(pages: Page[]) {
  let jumpToMessage: NativeChatQuoteJump | null = null
  const spies = { holdHistory: vi.fn(), readerLeavesEnd: vi.fn(), loadEarlier: vi.fn() }
  const view = render(
    <Transcript pages={pages} spies={spies} onJump={(jump) => (jumpToMessage = jump)} />
  )
  const click = (text: string, source: QuoteSource) => {
    rememberNativeChatQuoteSource(text, source)
    const notifyMissing = vi.fn()
    act(() => {
      jumpToQuoteSource(text, { jumpToMessage, openFile: null, notifyMissing })
    })
    return notifyMissing
  }
  return { view, spies, click }
}

const reply = (id: string, chatKey: string | undefined = CHAT): QuoteSource => ({
  messageId: id,
  place: null,
  ...(chatKey ? { chat: chatKey } : {})
})

it('pages older history in until the quoted reply is loaded, then shows the quote in it', async () => {
  const { view, spies, click } = chat(['between-1', 'between-0', 'old-reply'])
  const notifyMissing = click('quoted text', reply('old-reply'))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(shown).toHaveBeenCalledWith(
    view.container.querySelector('[data-native-chat-quote-source="old-reply"]'),
    'quoted text',
    null
  )
  expect(spies.holdHistory).toHaveBeenCalled()
  expect(notifyMissing).not.toHaveBeenCalled()
  // "Add to chat" reads this chat here.
  expect(view.container.firstElementChild?.getAttribute('data-native-chat-quote-chat')).toBe(CHAT)
})

it('pages a source stored before sources had a chat, as one of this chat', async () => {
  const { click } = chat(['old-reply'])
  click('quoted text', reply('old-reply', undefined))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
})

it('shows the notice once when no older page has the quoted reply', async () => {
  const { click } = chat(['between-0'])
  const notifyMissing = click('quoted text', reply('old-reply'))
  await waitFor(() => expect(notifyMissing).toHaveBeenCalledOnce())
  expect(shown).not.toHaveBeenCalled()
})

it('jumps to a message of another chat that is loaded here', async () => {
  const { spies, click } = chat(['old-reply'])
  const notifyMissing = click('quoted text', reply('latest-1', 'claude:other'))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(notifyMissing).not.toHaveBeenCalled()
  expect(spies.loadEarlier).not.toHaveBeenCalled()
})

it('pages nothing for a quote from another chat, and shows the notice', () => {
  const { spies, click } = chat(['old-reply'])
  const notifyMissing = click('quoted text', reply('old-reply', 'claude:other'))
  expect(notifyMissing).toHaveBeenCalledOnce()
  expect(spies.loadEarlier).not.toHaveBeenCalled()
  expect(spies.holdHistory).not.toHaveBeenCalled()
})

it('shows no notice for a first chip whose paging a second chip click stopped', async () => {
  let page: (id: string) => void = none
  const slowPage = new Promise<string>((resolve) => (page = resolve))
  const { click } = chat([slowPage, 'second-reply'])
  const first = click('first text', reply('first-reply'))
  const second = click('second text', reply('latest-1'))
  page('between-0')
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  await act(async () => {})
  expect(shown).toHaveBeenCalledWith(expect.anything(), 'second text', null)
  expect(first).not.toHaveBeenCalled()
  expect(second).not.toHaveBeenCalled()
})

it('pages on after a page of an earlier read, which is not a stop', async () => {
  const { click } = chat(['superseded', 'old-reply'])
  const notifyMissing = click('quoted text', reply('old-reply'))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(notifyMissing).not.toHaveBeenCalled()
})

it('stops with no notice when two pages in a row are of an earlier read', async () => {
  const { spies, click } = chat(['superseded', 'superseded', 'old-reply'])
  const notifyMissing = click('quoted text', reply('old-reply'))
  await waitFor(() => expect(spies.loadEarlier).toHaveBeenCalledTimes(2))
  await act(async () => {})
  expect(notifyMissing).not.toHaveBeenCalled()
  expect(shown).not.toHaveBeenCalled()
})

it('takes the reader off the end only when a paged reply lands', async () => {
  const missing = chat([])
  missing.click('quoted text', reply('old-reply'))
  await act(async () => {})
  expect(missing.spies.readerLeavesEnd).not.toHaveBeenCalled()
  cleanup()
  const landing = chat(['old-reply'])
  landing.click('quoted text', reply('old-reply'))
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(landing.spies.readerLeavesEnd).toHaveBeenCalledOnce()
})
