/** Inject safeStorage-compatible encryption without Electron imports in plain-Node hosts. Unavailable sealing
 * returns false; callers choose degradation (persistence keeps prior sealed blobs). Report protection gaps to users. */

export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(cipher: Buffer): string
  /** Report weak/no protection separately from capability: marking weak backends unavailable would skip decryption
   * and hide existing credentials. Null means protected; a message describes the gap. */
  describeProtectionGap(): string | null
}

/** Keep the installed store through vi.resetModules; a module-local slot would disappear from re-imported graphs. */
const SLOT = Symbol.for('orca.host.secretStore')

type Slot = { [SLOT]?: SecretStore | null }

function slot(): Slot {
  return globalThis as unknown as Slot
}

function read(): SecretStore | null {
  return slot()[SLOT] ?? null
}

export function setSecretStore(store: SecretStore): void {
  slot()[SLOT] = store
}

export function getSecretStore(): SecretStore {
  const current = read()
  if (!current) {
    throw new Error(
      'SecretStore not initialized — call setSecretStore() during startup before reading or writing secrets'
    )
  }
  return current
}

export function hasSecretStore(): boolean {
  return read() !== null
}

/** Test-only: drop the installed store so suites do not leak one across files. */
export function _resetSecretStoreForTests(): void {
  slot()[SLOT] = null
}
