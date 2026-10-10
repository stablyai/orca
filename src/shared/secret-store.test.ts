import { describe, expect, it, beforeEach } from 'vitest'
import {
  getSecretStore,
  hasSecretStore,
  _resetSecretStoreForTests,
  setSecretStore,
  type SecretStore
} from './secret-store'

function fakeStore(overrides: Partial<SecretStore> = {}): SecretStore {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plainText) => Buffer.from(`sealed:${plainText}`),
    decryptString: (cipher) => cipher.toString().slice('sealed:'.length),
    describeProtectionGap: () => null,
    ...overrides
  }
}

describe('SecretStore registry', () => {
  beforeEach(() => {
    _resetSecretStoreForTests()
  })

  it('throws until a store is installed, rather than defaulting to one that cannot seal', () => {
    expect(hasSecretStore()).toBe(false)
    expect(() => getSecretStore()).toThrow(/SecretStore not initialized/)
  })

  it('returns the installed store', () => {
    const store = fakeStore()
    setSecretStore(store)
    expect(hasSecretStore()).toBe(true)
    expect(getSecretStore()).toBe(store)
    expect(getSecretStore().encryptString('token').toString()).toBe('sealed:token')
  })

  it('lets a later install replace an earlier one, so a test fake wins over the global default', () => {
    setSecretStore(fakeStore())
    setSecretStore(fakeStore({ isEncryptionAvailable: () => false }))
    expect(getSecretStore().isEncryptionAvailable()).toBe(false)
  })

  it('carries a reason when sealing is unavailable, so the degradation can be surfaced', () => {
    setSecretStore(
      fakeStore({
        isEncryptionAvailable: () => false,
        describeProtectionGap: () => 'The OS keyring is unavailable.'
      })
    )
    expect(getSecretStore().describeProtectionGap()).toBe('The OS keyring is unavailable.')
  })
})
