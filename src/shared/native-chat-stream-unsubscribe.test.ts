import { describe, expect, it } from 'vitest'
import {
  buildNativeChatSubscriptionId,
  buildNativeChatUnsubscribe
} from './native-chat-stream-unsubscribe'

describe('native-chat stream unsubscribe key builder', () => {
  it('derives the cleanup token as agent:sessionId', () => {
    expect(buildNativeChatSubscriptionId('claude', 'sess-1')).toBe('claude:sess-1')
  })

  it('builds the unsubscribe RPC frame mobile and web share', () => {
    expect(buildNativeChatUnsubscribe('codex', 'abc')).toEqual({
      method: 'nativeChat.unsubscribe',
      params: { subscriptionId: 'codex:abc' }
    })
  })

  it('echoes a pane-specific token when the subscriber supplied one', () => {
    expect(buildNativeChatUnsubscribe('claude', 'same-session', 'pane-2')).toEqual({
      method: 'nativeChat.unsubscribe',
      params: { subscriptionId: 'pane-2' }
    })
  })
})
