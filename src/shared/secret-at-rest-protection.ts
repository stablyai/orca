/**
 * How a credential Orca already wrote is protected on disk.
 *
 * Why this is about the stored bytes and not `isEncryptionAvailable()`: the two disagree
 * exactly when it matters. A key saved on a host with no usable keyring stays plaintext
 * forever, even after a keyring appears and sealing starts working — nothing rewrites it
 * until the user saves again. Reporting current capability would tell that user their key
 * is protected when the file on disk says otherwise.
 */
export type SecretAtRestProtection =
  /** Sealed by the OS keyring via safeStorage. */
  | 'sealed'
  /** Readable by anyone who can read the file, a backup of it, or the raw disk. */
  | 'plaintext'

/**
 * Classify a credential file that stores raw ciphertext with no envelope.
 *
 * Why a heuristic: these stores (speech, Linear, Jira, Bitbucket) write either
 * `safeStorage` ciphertext or the bare token, with nothing on disk to tell them apart.
 * This is the same test `readStoredCredentialToken` already uses to decide whether a
 * file is a legacy plaintext token, kept in one place so the reader and the reporter
 * cannot drift into disagreeing about the same bytes.
 *
 * Prefer an explicit envelope where one exists — the MiniMax stores record their own
 * kind and do not need to guess.
 */
export function classifyUnenvelopedCredential(raw: Buffer): SecretAtRestProtection {
  const text = raw.toString('utf8')
  // Ciphertext (a macOS v10 blob, or Chromium's AES payload) is not valid printable
  // UTF-8; a token is. Buffer.toString replaces invalid sequences with U+FFFD.
  if (text.includes('�')) {
    return 'sealed'
  }
  // oxlint-disable-next-line no-control-regex -- Sealed payloads are binary, so control bytes are the signal.
  return /[\u0000-\u0008\u000E-\u001F]/.test(text) ? 'sealed' : 'plaintext'
}
