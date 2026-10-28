import { expect, it } from 'vitest'
import { parseMobilePushRegistration } from './mobile-push-contract'
it('rejects malformed known preferences', () => {
  expect(
    parseMobilePushRegistration({
      registrationId: 'r',
      expiresAt: Date.now() + 60000,
      filter: { onlyWhenDesktopAway: 'true' }
    })
  ).toBeUndefined()
})

it('retains valid preferences while ignoring unknown fields', () => {
  expect(
    parseMobilePushRegistration({
      registrationId: 'r',
      expiresAt: 123,
      filter: { onlyWhenDesktopAway: true, sound: false, unknown: true }
    })?.filter
  ).toEqual({ onlyWhenDesktopAway: true, sound: false })
})
