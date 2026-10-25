/** Report stored bytes, not current sealing capability: installing a keyring does not rewrite a previously plaintext key. */
export type SecretAtRestProtection =
  /** Sealed by the OS keyring via safeStorage. */
  | 'sealed'
  /** Readable by anyone who can read the file, a backup of it, or the raw disk. */
  | 'plaintext'

/** Legacy stores mix bare tokens and raw safeStorage ciphertext without an envelope; share the reader’s heuristic
 * to keep reporting consistent. Prefer explicit kinds in stores that have them (e.g. MiniMax). */
export function classifyUnenvelopedCredential(raw: Buffer): SecretAtRestProtection {
  const text = raw.toString('utf8')
  // Ciphertext is not printable UTF-8; Buffer.toString replaces malformed sequences with U+FFFD.
  if (text.includes('�')) {
    return 'sealed'
  }
  // oxlint-disable-next-line no-control-regex -- Sealed payloads are binary, so control bytes are the signal.
  return /[\u0000-\u0008\u000E-\u001F]/.test(text) ? 'sealed' : 'plaintext'
}
