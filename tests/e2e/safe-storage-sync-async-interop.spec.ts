import { expect } from '@stablyai/playwright-test'
import { test } from './helpers/orca-app'

// Why: credential writers seal with the async safeStorage API while some readers, and any
// older Orca, still unseal with the sync one. Each API must read the other's ciphertext.
test('safeStorage sync and async ciphertexts decrypt with either API', async ({ electronApp }) => {
  await electronApp.firstWindow({ timeout: 120_000 })
  const result = await electronApp.evaluate(async ({ safeStorage }) => {
    const syncAvailable = safeStorage.isEncryptionAvailable()
    const asyncAvailable = await safeStorage.isAsyncEncryptionAvailable()
    if (!syncAvailable || !asyncAvailable) {
      return { syncAvailable, asyncAvailable }
    }
    const secret = 'orca-interop-✓'
    const sealedSync = safeStorage.encryptString(secret)
    const sealedAsync = await safeStorage.encryptStringAsync(secret)
    const unsealedSync = await safeStorage.decryptStringAsync(sealedSync)
    return {
      syncAvailable,
      asyncAvailable,
      asyncReadsSync: unsealedSync.result,
      asyncAsksReEncrypt: unsealedSync.shouldReEncrypt,
      syncReadsAsync: safeStorage.decryptString(sealedAsync)
    }
  })
  // Why: a save stores plaintext when the async check says no, so it must agree with the sync one.
  expect(result.asyncAvailable).toBe(result.syncAvailable)
  test.skip(!result.syncAvailable, 'this host has no safeStorage backend')
  expect(result).toEqual({
    syncAvailable: true,
    asyncAvailable: true,
    asyncReadsSync: 'orca-interop-✓',
    asyncAsksReEncrypt: false,
    syncReadsAsync: 'orca-interop-✓'
  })
})
