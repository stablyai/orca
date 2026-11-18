import { describe, expect, it } from 'vitest'
import { nativeChatUsageLimitAutoContinueUnavailable } from './native-chat-usage-limit-auto-continue'

describe('nativeChatUsageLimitAutoContinueUnavailable', () => {
  it('is unavailable on a host without the feature, wherever it runs', () => {
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('unsupported', undefined, { localHost: true })
    ).toBe(true)
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('unsupported', undefined, { localHost: false })
    ).toBe(true)
  })

  it("is unavailable when another machine's own setting is off, not this machine's", () => {
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('supported', 'off', { localHost: false })
    ).toBe(true)
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('supported', 'off', { localHost: true })
    ).toBe(false)
  })

  it('stays available while the capability loads or the state is unpublished', () => {
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('unknown', undefined, { localHost: false })
    ).toBe(false)
    expect(
      nativeChatUsageLimitAutoContinueUnavailable('supported', undefined, { localHost: false })
    ).toBe(false)
  })
})
