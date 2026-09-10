import { describe, expect, it } from 'vitest'
import { isMobileRelayAllowed } from './mobile-relay-policy'

describe('isMobileRelayAllowed', () => {
  it('lets the host setting withdraw Relay from an automatic device', () => {
    expect(
      isMobileRelayAllowed({ hostConnectionMode: 'local-only', deviceConnectionMode: 'automatic' })
    ).toBe(false)
    expect(
      isMobileRelayAllowed({ hostConnectionMode: 'automatic', deviceConnectionMode: 'automatic' })
    ).toBe(true)
  })

  it('never lets the host setting grant Relay to a local-only device', () => {
    expect(
      isMobileRelayAllowed({ hostConnectionMode: 'automatic', deviceConnectionMode: 'local-only' })
    ).toBe(false)
  })

  it('treats an unplaceable device as having no opinion', () => {
    expect(
      isMobileRelayAllowed({ hostConnectionMode: 'automatic', deviceConnectionMode: null })
    ).toBe(true)
    expect(
      isMobileRelayAllowed({ hostConnectionMode: 'local-only', deviceConnectionMode: null })
    ).toBe(false)
  })
})
