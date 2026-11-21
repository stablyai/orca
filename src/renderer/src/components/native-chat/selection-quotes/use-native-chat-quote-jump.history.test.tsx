// @vitest-environment happy-dom
import { useCallback, useRef, useState } from 'react'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-quote-highlight', () => ({ showQuotedText: shown }))

import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'
import {
  useNativeChatNavigation,
  useNativeChatNavigationRequest
} from '../viewport/navigation/use-native-chat-transcript-navigation'
import { jumpToQuoteSource, rememberNativeChatQuoteSource } from './native-chat-quote-sources'
import type { NativeChatQuoteJump } from './use-native-chat-quote-jump'

afterEach(() => {
  cleanup()
  shown.mockReset()
  localStorage.clear()
})

const none = () => {}

function slot(id: string): NativeChatTranscriptSlot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation reads only each slot's kind and message id.
  return { kind: 'message', message: { id } } as unknown as NativeChatTranscriptSlot
}

// A long chat: the quoted reply is in older history, which a send to the end trimmed away.
function Transcript({
  older,
  onJump,
  holdHistory
}: {
  older: string[]
  onJump: (jump: NativeChatQuoteJump) => void
  holdHistory: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState(() => ['latest-0', 'latest-1'].map(slot))
  const pages = useRef([...older])
  const loadEarlier = useCallback(async () => {
    const page = pages.current.pop()
    if (page === undefined) {
      return 'exhausted' as const
    }
    setSlots((current) => [slot(page), ...current])
    return 'applied' as const
  }, [])
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
    sessionKey: 'session-1',
    sessionId: 'session-1',
    isVisible: true,
    loadEarlier,
    holdHistory,
    releaseHistory: none,
    scrollRef,
    scrollMessageToTop: none,
    readerLeavesEnd: none,
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

function chipClick(older: string[]) {
  let jumpToMessage: NativeChatQuoteJump | null = null
  const holdHistory = vi.fn()
  const view = render(
    <Transcript older={older} holdHistory={holdHistory} onJump={(jump) => (jumpToMessage = jump)} />
  )
  rememberNativeChatQuoteSource('quoted text', { messageId: 'old-reply', place: null })
  const notifyMissing = vi.fn()
  act(() => {
    jumpToQuoteSource('quoted text', { jumpToMessage, openFile: null, notifyMissing })
  })
  return { view, holdHistory, notifyMissing }
}

it('pages older history in until the quoted reply is loaded, then shows the quote in it', async () => {
  const { view, holdHistory, notifyMissing } = chipClick(['old-reply', 'between-0', 'between-1'])
  await waitFor(() => expect(shown).toHaveBeenCalledOnce())
  expect(shown).toHaveBeenCalledWith(
    view.container.querySelector('[data-native-chat-quote-source="old-reply"]'),
    'quoted text',
    null
  )
  expect(holdHistory).toHaveBeenCalled()
  expect(notifyMissing).not.toHaveBeenCalled()
})

it('shows the notice once when no older page has the quoted reply', async () => {
  const { notifyMissing } = chipClick(['between-0'])
  await waitFor(() => expect(notifyMissing).toHaveBeenCalledOnce())
  expect(shown).not.toHaveBeenCalled()
})
