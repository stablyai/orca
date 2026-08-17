import { describe, expect, it } from 'vitest'
import { parseRuntimeNativeChatReadSessionResult } from './native-chat-runtime-contract'

// The paging flag decides whether a head turn's `[Image #n]` run reads as the
// user's own words, so it has to survive the runtime hop rather than be
// re-inferred from the message count on this side.
describe('parseRuntimeNativeChatReadSessionResult', () => {
  it('keeps the host’s paging answer when it sends one', () => {
    expect(parseRuntimeNativeChatReadSessionResult({ messages: [], hasMore: true })).toEqual({
      messages: [],
      hasMore: true
    })
    expect(parseRuntimeNativeChatReadSessionResult({ messages: [], hasMore: false })).toEqual({
      messages: [],
      hasMore: false
    })
  })

  it('omits it for an older host, leaving the caller to infer from the count', () => {
    expect(parseRuntimeNativeChatReadSessionResult({ messages: [] })).toEqual({ messages: [] })
  })

  it('ignores a non-boolean, so a malformed payload cannot force a paging answer', () => {
    expect(parseRuntimeNativeChatReadSessionResult({ messages: [], hasMore: 'yes' })).toEqual({
      messages: []
    })
  })

  it('passes an error result through untouched', () => {
    expect(parseRuntimeNativeChatReadSessionResult({ error: 'boom', notFound: true })).toEqual({
      error: 'boom',
      notFound: true
    })
  })
})
