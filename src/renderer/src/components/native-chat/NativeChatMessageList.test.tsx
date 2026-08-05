// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CHAT_LOAD_EARLIER_ERROR } from '../../../../shared/native-chat-load-earlier'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

function session(
  loadEarlier: () => void,
  loadEarlierError: string | null,
  messages: NativeChatMessage[] = [],
  loadingEarlier = false,
  historySourceKey = 'source-1'
): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session',
    agent: 'claude',
    hasMore: true,
    loadingEarlier,
    loadEarlierError,
    loadEarlier,
    historySourceKey,
    readPhase: 'ready'
  }
}

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'user',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

function setScrollHeight(scroller: HTMLElement, value: number): void {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, writable: true, value })
}

function renderList(
  loadEarlier: () => void,
  loadEarlierError: string | null,
  initialMessages: NativeChatMessage[] = []
): {
  scroller: HTMLElement
  rerender: (
    error: string | null,
    messages?: NativeChatMessage[],
    loadingEarlier?: boolean,
    historySourceKey?: string
  ) => void
} {
  const list = (
    error: string | null,
    messages: NativeChatMessage[] = [],
    loadingEarlier = false,
    historySourceKey = 'source-1'
  ) => (
    <NativeChatMessageList
      session={session(loadEarlier, error, messages, loadingEarlier, historySourceKey)}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
  const view = render(list(loadEarlierError, initialMessages))
  const scroller = view.container.querySelector<HTMLElement>('.scrollbar-sleek')
  if (!scroller) {
    throw new Error('Missing native chat scroller')
  }
  Object.defineProperties(scroller, {
    scrollTop: { configurable: true, writable: true, value: 0 },
    scrollHeight: { configurable: true, writable: true, value: 1_000 },
    clientHeight: { configurable: true, value: 400 }
  })
  return {
    scroller,
    rerender: (error, messages, loadingEarlier, historySourceKey) =>
      view.rerender(list(error, messages, loadingEarlier, historySourceKey))
  }
}

describe('NativeChatMessageList load earlier', () => {
  afterEach(cleanup)

  it('loads automatically near the top before a failure', () => {
    const loadEarlier = vi.fn()
    const { scroller } = renderList(loadEarlier, null)

    fireEvent.scroll(scroller)

    expect(loadEarlier).toHaveBeenCalledOnce()
  })

  it('blocks scroll retries after failure but keeps explicit retry', () => {
    const loadEarlier = vi.fn()
    const { scroller } = renderList(loadEarlier, NATIVE_CHAT_LOAD_EARLIER_ERROR)

    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    fireEvent.scroll(scroller)
    expect(loadEarlier).not.toHaveBeenCalled()

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Couldn’t load earlier messages. Try again'
      })
    )
    expect(loadEarlier).toHaveBeenCalledOnce()
  })

  it('announces a load-earlier failure that arrives after automatic paging', () => {
    const { rerender } = renderList(vi.fn(), null)
    expect(screen.getByRole('status')).toBeEmptyDOMElement()

    rerender(NATIVE_CHAT_LOAD_EARLIER_ERROR)

    expect(screen.getByRole('status')).toHaveTextContent(
      'Couldn’t load earlier messages. Try again'
    )
  })

  it('discards a failed page anchor before live content grows', () => {
    const loadEarlier = vi.fn()
    const { scroller, rerender } = renderList(loadEarlier, null)
    fireEvent.scroll(scroller)

    setScrollHeight(scroller, 1_100)
    rerender(NATIVE_CHAT_LOAD_EARLIER_ERROR, [message('live')])

    expect(scroller.scrollTop).toBe(0)
  })

  it('captures current geometry again for an explicit retry', () => {
    const loadEarlier = vi.fn()
    const { scroller, rerender } = renderList(loadEarlier, null)
    fireEvent.scroll(scroller)
    rerender(NATIVE_CHAT_LOAD_EARLIER_ERROR)
    scroller.scrollTop = 25
    setScrollHeight(scroller, 1_200)

    fireEvent.click(screen.getByRole('button', { name: /Couldn’t load earlier messages/ }))
    setScrollHeight(scroller, 1_300)
    rerender(null, [message('older')])

    expect(scroller.scrollTop).toBe(125)
  })

  it('keeps a visible-row anchor while live messages arrive during an older-page read', () => {
    const loadEarlier = vi.fn()
    const current = message('current')
    const { scroller, rerender } = renderList(loadEarlier, null, [current])
    const row = scroller.querySelector<HTMLElement>('[data-native-chat-message-id="current"]')
    if (!row) {
      throw new Error('Missing current message row')
    }
    let rowTop = 100
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ y: 0, height: 400 })
    )
    vi.spyOn(row, 'getBoundingClientRect').mockImplementation(() =>
      DOMRect.fromRect({ y: rowTop, height: 40 })
    )

    fireEvent.scroll(scroller)
    setScrollHeight(scroller, 1_100)
    rerender(null, [current, message('live')], true)
    expect(scroller.scrollTop).toBe(0)

    rowTop = 220
    setScrollHeight(scroller, 1_300)
    rerender(null, [message('older'), current, message('live')], false)

    expect(scroller.scrollTop).toBe(120)
  })

  it('clears a settled no-growth anchor before later live content arrives', () => {
    const loadEarlier = vi.fn()
    const { scroller, rerender } = renderList(loadEarlier, null)
    fireEvent.scroll(scroller)
    rerender(null, [], true)
    rerender(null, [], false)

    setScrollHeight(scroller, 1_100)
    rerender(null, [message('live')])

    expect(scroller.scrollTop).toBe(0)
  })

  it('does not restore a stale anchor after the user scrolls during the request', () => {
    const loadEarlier = vi.fn()
    const current = message('current')
    const { scroller, rerender } = renderList(loadEarlier, null, [current])
    const row = scroller.querySelector<HTMLElement>('[data-native-chat-message-id="current"]')
    if (!row) {
      throw new Error('Missing current message row')
    }
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ y: 0, height: 400 })
    )
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: 100, height: 40 }))

    fireEvent.scroll(scroller)
    rerender(null, [current], true)
    scroller.scrollTop = 200
    fireEvent.scroll(scroller)
    setScrollHeight(scroller, 1_300)
    rerender(null, [message('older'), current], false)

    expect(scroller.scrollTop).toBe(200)
  })

  it('drops a pending anchor when the owning transcript source changes', () => {
    const loadEarlier = vi.fn()
    const current = message('current')
    const { scroller, rerender } = renderList(loadEarlier, null, [current])
    fireEvent.scroll(scroller)
    rerender(null, [current], true)

    setScrollHeight(scroller, 1_300)
    rerender(null, [message('replacement')], false, 'source-2')

    expect(scroller.scrollTop).toBe(0)
  })
})
