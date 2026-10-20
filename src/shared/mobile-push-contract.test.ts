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

it('keeps a known sealed-content format and degrades an unknown one to readable pushes', () => {
  const stored = { registrationId: 'r', expiresAt: 123, filter: {} }
  expect(parseMobilePushRegistration({ ...stored, sealedContent: 'e2e1' })?.sealedContent).toBe(
    'e2e1'
  )
  const unknown = parseMobilePushRegistration({ ...stored, sealedContent: 'e2e9' })
  expect(unknown).toEqual(stored)
})
