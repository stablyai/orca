import { expect, it } from 'vitest'
import { pairingCredentialAvailableWhileLocked } from '../../../mobile/src/host-credentials/pairing-keychain-accessibility'

it('limits locked-phone access to paired sends and encrypted reply recovery', () => {
  expect(pairingCredentialAvailableWhileLocked('orca.host-token.paired-host', 'ios')).toBe(true)
  expect(
    pairingCredentialAvailableWhileLocked('orca.mobile-relay.credentials.paired-host', 'ios')
  ).toBe(true)
  expect(pairingCredentialAvailableWhileLocked('orca.notification-reply-key.v1', 'ios')).toBe(true)
  expect(pairingCredentialAvailableWhileLocked('orca.notification-reply-key.v1', 'android')).toBe(
    false
  )
  for (const platform of ['ios', 'android', 'web']) {
    expect(pairingCredentialAvailableWhileLocked('orca.device-store-key.v1', platform)).toBe(false)
    expect(pairingCredentialAvailableWhileLocked('orca.pairing-journal.secrets', platform)).toBe(
      false
    )
  }
  expect(pairingCredentialAvailableWhileLocked('orca.host-token.paired-host', 'android')).toBe(
    false
  )
})
