import { describe, expect, it } from 'vitest'
import {
  hasMoreNativeChatHistory,
  NATIVE_CHAT_INITIAL_LIMIT,
  NATIVE_CHAT_PAGE,
  nextNativeChatLimit
} from './native-chat-pagination'

describe('nextNativeChatLimit', () => {
  it('grows the limit by one page', () => {
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE
    )
    expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE)).toBe(
      NATIVE_CHAT_INITIAL_LIMIT + 2 * NATIVE_CHAT_PAGE
    )
  })
})

describe('hasMoreNativeChatHistory', () => {
  it('reports more when the read filled the requested window', () => {
    expect(hasMoreNativeChatHistory(300, 300)).toBe(true)
    expect(hasMoreNativeChatHistory(301, 300)).toBe(true)
  })

  it('reports done when the read returned fewer than requested (head reached)', () => {
    expect(hasMoreNativeChatHistory(120, 300)).toBe(false)
    expect(hasMoreNativeChatHistory(0, 300)).toBe(false)
  })

  // The count inference cannot tell "the window is exactly full" from "there is
  // more behind it", so a reported `false` ends pagination without the wasted
  // read the count rule alone costs.
  it('takes the host’s reported answer when it ends pagination', () => {
    expect(hasMoreNativeChatHistory(300, 300, false)).toBe(false)
  })

  // A reported `true` says history exists, not that the next read can reach it.
  // The runtime RPC host clamps the window to 2000 turns and then answers `true`
  // forever while returning the same capped tail; trusting it alone left a
  // "Load earlier" button that re-read the whole window and never grew it.
  it('still ends pagination when the read came back short of the window', () => {
    expect(hasMoreNativeChatHistory(120, 300, true)).toBe(false)
    expect(hasMoreNativeChatHistory(2000, 2100, true)).toBe(false)
    // The window is still growing, so keep paging.
    expect(hasMoreNativeChatHistory(300, 300, true)).toBe(true)
  })

  it('falls back to the count when an older host reports nothing', () => {
    expect(hasMoreNativeChatHistory(300, 300, undefined)).toBe(true)
    expect(hasMoreNativeChatHistory(120, 300, undefined)).toBe(false)
  })
})
