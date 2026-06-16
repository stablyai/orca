import { sha256 } from './sha256'

export type OrcaHookScriptKind = 'setup' | 'archive' | 'issueCommand'

export async function hashOrcaHookScript(content: string): Promise<string> {
  const normalized = content.trim()
  const bytes = new TextEncoder().encode(normalized)
  // Why: crypto.subtle is undefined in non-secure browser contexts (LAN web
  // client over plain HTTP). Both paths must yield the SAME SHA-256 digest so
  // the shared trust store matches across Electron/HTTPS and HTTP — the JS
  // fallback is SHA-256, not SHA-512.
  // Cast: the Electron type lib declares subtle non-optional, but the browser
  // leaves it undefined off a secure context.
  const subtle = (globalThis.crypto as Crypto | undefined)?.subtle as SubtleCrypto | undefined
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes)
    return bytesToHex(new Uint8Array(digest))
  }
  return bytesToHex(sha256(bytes))
}

function bytesToHex(view: Uint8Array): string {
  const hex: string[] = []
  for (let i = 0; i < view.length; i += 1) {
    hex.push(view[i].toString(16).padStart(2, '0'))
  }
  return hex.join('')
}
