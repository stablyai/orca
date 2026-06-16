import nacl from 'tweetnacl'

export type OrcaHookScriptKind = 'setup' | 'archive' | 'issueCommand'

export async function hashOrcaHookScript(content: string): Promise<string> {
  const normalized = content.trim()
  const bytes = new TextEncoder().encode(normalized)
  // Why: crypto.subtle is undefined in non-secure browser contexts (LAN web
  // client over plain HTTP). Prefer it where present so existing trust hashes
  // stay valid on Electron/HTTPS; fall back to a JS SHA-512 elsewhere.
  // Cast: the Electron type lib declares subtle non-optional, but the browser
  // leaves it undefined off a secure context.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle as SubtleCrypto | undefined
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return bytesToHex(new Uint8Array(digest))
  }
  return bytesToHex(nacl.hash(bytes))
}

function bytesToHex(view: Uint8Array): string {
  const hex: string[] = []
  for (let i = 0; i < view.length; i += 1) {
    hex.push(view[i].toString(16).padStart(2, '0'))
  }
  return hex.join('')
}
