/**
 * SecretStore abstracts at-rest secret encryption that the desktop app gets from
 * Electron's `safeStorage` (OS keychain). The headless `@stablyai/orca-server` installs a
 * Node implementation so the runtime core never imports `electron`.
 *
 * The contract mirrors safeStorage exactly: encryptString -> Buffer,
 * decryptString(Buffer) -> string, isEncryptionAvailable -> boolean. Callers
 * already handle isEncryptionAvailable()===false by storing plaintext, so a
 * store that returns false is a safe (if weaker) baseline.
 *
 * Settable singleton for the same reason as AppEnvironment: safeStorage is read
 * through deep call chains; the Electron default keeps desktop behavior
 * identical and the node entrypoint overrides it once at boot.
 */
export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipher: Buffer): string
}

let current: SecretStore | null = null

export function setSecretStore(store: SecretStore): void {
  current = store
}

export function getSecretStore(): SecretStore {
  if (!current) {
    // Under vitest (incl. after vi.resetModules()), install a benign default so
    // tests don't each re-wire it. The default mirrors the plaintext-fallback
    // contract (isEncryptionAvailable=false); tests asserting real ciphertext
    // semantics install their own store. Production must call setSecretStore().
    if (process.env.VITEST) {
      current = createTestDefaultSecretStore()
      return current
    }
    throw new Error(
      'SecretStore not initialized — call setSecretStore() before encrypting/decrypting secrets'
    )
  }
  return current
}

function createTestDefaultSecretStore(): SecretStore {
  return {
    isEncryptionAvailable: () => false,
    encryptString: (plainText: string) => Buffer.from(plainText, 'utf-8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf-8')
  }
}

export function hasSecretStore(): boolean {
  return current !== null
}

export function __resetSecretStoreForTests(): void {
  current = null
}
