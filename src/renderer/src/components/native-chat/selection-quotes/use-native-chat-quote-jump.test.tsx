// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const shown = vi.hoisted(() => vi.fn())
vi.mock('./native-chat-quote-highlight', () => ({ showQuotedText: shown }))

import { useNativeChatQuoteJump } from './use-native-chat-quote-jump'
import { beginLinkOpenRequest } from '@/lib/links/link-open-request'
import { jumpToQuoteSource, rememberNativeChatQuoteSource } from './native-chat-quote-sources'
import type { NativeChatTranscriptSlot } from '../conversation/slots/native-chat-transcript-slots'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame'] })
})

afterEach(() => {
  vi.useRealTimers()
  shown.mockReset()
  localStorage.clear()
})

const current = () => true

function jump(scroller: HTMLDivElement) {
  const issue = vi.fn()
  const startHistoryJump = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the jump reads only each slot's kind and message id.
  const slots = [
    { kind: 'message', message: { id: 'reply-0' } },
    { kind: 'message', message: { id: 'reply-1' } }
  ] as unknown as NativeChatTranscriptSlot[]
  const { result } = renderHook(() =>
    useNativeChatQuoteJump({
      slots,
      scrollRef: { current: scroller },
      request: { issue, nextRequestId: () => 7 },
      beginNavigation: vi.fn(),
      readerLeavesEnd: vi.fn(),
      startHistoryJump,
      sessionKey: 'claude:s1',
      unfoldTurnOf: () => false
    })
  )
  return { issue, startHistoryJump, jumpTo: result.current }
}

it('scrolls to the quoted message as a rail jump does, then shows the text in it', () => {
  const scroller = document.createElement('div')
  scroller.innerHTML =
    '<div data-index="0"><div data-native-chat-quote-source="reply-0">Another reply.</div></div>' +
    '<div data-index="1"><div data-native-chat-quote-source="reply-1">The quoted text.</div></div>'
  const { issue, startHistoryJump, jumpTo } = jump(scroller)
  const place = { offset: 4, length: 11, hash: 'h' }
  const notifyMissing = vi.fn()
  expect(jumpTo({ messageId: 'not-loaded', place: null }, 'x', notifyMissing, current)).toBe(true)
  expect(issue).not.toHaveBeenCalled()
  expect(startHistoryJump).toHaveBeenCalledWith(
    { kind: 'item', id: 'not-loaded' },
    expect.any(Function)
  )
  expect(jumpTo({ messageId: 'reply-1', place }, 'quoted text', notifyMissing, current)).toBe(true)
  expect(issue).toHaveBeenCalledWith({ kind: 'rail', messageId: 'reply-1', requestId: 7 })
  vi.advanceTimersToNextFrame()
  vi.advanceTimersToNextFrame()
  expect(shown).toHaveBeenCalledWith(
    scroller.querySelector('[data-native-chat-quote-source="reply-1"]'),
    'quoted text',
    place
  )
  expect(notifyMissing).not.toHaveBeenCalled()
})

it('shows the text when the message is drawn late, and a notice when it is never drawn', () => {
  const scroller = document.createElement('div')
  const { jumpTo } = jump(scroller)
  const notifyMissing = vi.fn()
  jumpTo({ messageId: 'reply-1', place: null }, 'quoted text', notifyMissing, current)
  for (let frame = 0; frame < 5; frame++) {
    vi.advanceTimersToNextFrame()
  }
  scroller.innerHTML = '<div data-native-chat-quote-source="reply-1">The quoted text.</div>'
  vi.advanceTimersToNextFrame()
  expect(shown).toHaveBeenCalledOnce()
  jumpTo({ messageId: 'reply-0', place: null }, 'other text', notifyMissing, current)
  for (let frame = 0; frame < 30; frame++) {
    vi.advanceTimersToNextFrame()
  }
  expect(shown).toHaveBeenCalledOnce()
  expect(notifyMissing).toHaveBeenCalledOnce()
})

// The older click targets a reply drawn only after the newer click, or a file whose open is still
// pending. The fake open keeps the contract of openDetectedFilePath: it takes a link-open turn and
// opens only while that turn is current.
it.each([
  ['message', 'message'],
  ['message', 'file'],
  ['file', 'message'],
  ['file', 'file']
])('a %s chip click, then a %s chip click: only the newer one acts', (older, newer) => {
  const scroller = document.createElement('div')
  scroller.innerHTML = '<div data-native-chat-quote-source="reply-1">The newer text.</div>'
  const { jumpTo } = jump(scroller)
  const quotes = {
    older: older === 'message' ? 'older words' : 'src/older.ts:3\n```ts\nolder\n```',
    newer: newer === 'message' ? 'newer words' : 'src/newer.ts:7\n```ts\nnewer\n```'
  }
  rememberNativeChatQuoteSource('older words', { messageId: 'reply-0', place: null })
  rememberNativeChatQuoteSource('newer words', { messageId: 'reply-1', place: null })
  const opened: string[] = []
  const pendingOpens: (() => void)[] = []
  const notices: string[] = []
  const click = (which: 'older' | 'newer') =>
    jumpToQuoteSource(quotes[which], {
      jumpToMessage: jumpTo,
      openFile: ({ pathText }) => {
        const isCurrent = beginLinkOpenRequest()
        pendingOpens.push(() => {
          if (isCurrent()) {
            opened.push(pathText)
          }
        })
        return true
      },
      notifyMissing: () => notices.push(which)
    })
  click('older')
  vi.advanceTimersToNextFrame()
  click('newer')
  scroller.insertAdjacentHTML(
    'beforeend',
    '<div data-native-chat-quote-source="reply-0">The older text.</div>'
  )
  for (const open of pendingOpens) {
    open()
  }
  for (let frame = 0; frame < 30; frame++) {
    vi.advanceTimersToNextFrame()
  }
  expect(notices).toEqual([])
  expect(opened).toEqual(newer === 'file' ? ['src/newer.ts'] : [])
  expect(shown.mock.calls).toEqual(
    newer === 'message' ? [[scroller.firstElementChild, 'newer words', null]] : []
  )
})
