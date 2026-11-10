import { describe, expect, it } from 'vitest'
import { buildNativeChatUnsubscribe } from './native-chat-stream-unsubscribe'

describe('native-chat stream unsubscribe key builder', () => {
  it('echoes a pane-specific token when the subscriber supplied one', () => {
    expect(buildNativeChatUnsubscribe('claude', 'same-session', 'pane-2')).toEqual({
      method: 'nativeChat.unsubscribe',
      params: { subscriptionId: 'pane-2' }
    })
  })
})
