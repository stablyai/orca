import { expect, it } from 'vitest'
import { pairingCredentialAvailableWhileLocked } from '../../../mobile/src/host-credentials/pairing-keychain-accessibility'

it('limits locked-phone access to iOS pairing tokens and relay credentials', () => {
  expect(pairingCredentialAvailableWhileLocked('orca.host-token.paired-host', 'ios')).toBe(true)
  expect(
    pairingCredentialAvailableWhileLocked('orca.mobile-relay.credentials.paired-host', 'ios')
  ).toBe(true)
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
