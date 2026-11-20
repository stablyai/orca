/** Inject safeStorage-compatible encryption without Electron imports in plain-Node hosts. Unavailable sealing
 * returns false; callers choose degradation (persistence keeps prior sealed blobs). Report protection gaps to users. */

/** How strongly new secrets get sealed, for callers that refuse weak storage. */
export type SecretSealing =
  | { kind: 'os-keychain' }
  /** A key kept on this host; `warning` says who can still unseal. */
  | { kind: 'host-key'; warning: string }
  | { kind: 'none'; reason: string }

export type SecretStore = {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  /** Seals off the caller's thread where the host can; absent stores seal through encryptString. */
  encryptStringAsync?(plainText: string): Promise<Buffer>
  decryptString(cipher: Buffer): string
  /** Report weak/no protection separately from capability: marking weak backends unavailable would skip decryption
   * and hide existing credentials. Null means protected; a message describes the gap. */
  describeProtectionGap(): string | null
  /** Absent on stores that cannot tell; callers treat that as unsealed. */
  describeSealing?(): SecretSealing
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
