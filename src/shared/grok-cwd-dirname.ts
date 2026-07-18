/**
 * Grok session CWD directory encoding, aligned with xai-org/grok-build
 * `xai_grok_config::paths::encode_cwd_dirname` (Apache-2.0 source).
 *
 * Short CWDs: URL-encode (urlencoding crate / unreserved set).
 * Long CWDs (encoded > 255 bytes): `{slug40}-{blake3_hex16}` plus on-disk `.cwd`.
 */
import { blake3 } from '@noble/hashes/blake3'
import { bytesToHex } from '@noble/hashes/utils'

/** Filesystem max for a single directory name component (APFS/ext4/NTFS). */
export const GROK_ENCODED_CWD_DIR_MAX_BYTES = 255

const SLUG_MAX_CHARS = 40
const BLAKE3_HEX_PREFIX_LEN = 16

/**
 * Percent-encode like Rust `urlencoding::encode`: UTF-8 bytes of every character
 * outside the unreserved set (ALPHA / DIGIT / "-" / "." / "_" / "~").
 * `encodeURIComponent` leaves `!'()*` unescaped; Grok's encoder does not.
 */
export function encodeGrokUrlComponent(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * URL-safe slug from a path leaf: lowercase, non-alnum → `-`, collapse dashes,
 * trim, truncate to maxLen chars (matches Grok `slugify`).
 */
export function slugifyGrokCwdLeaf(input: string, maxLen: number = SLUG_MAX_CHARS): string {
  let result = ''
  let prevDash = false
  for (const char of input.toLowerCase()) {
    if (/[a-z0-9]/.test(char)) {
      result += char
      prevDash = false
    } else if (!prevDash) {
      result += '-'
      prevDash = true
    }
  }
  const trimmed = result.replace(/^-+|-+$/g, '')
  return [...trimmed].slice(0, maxLen).join('')
}

// Why: split on both `/` and `\` deliberately (not host Path.file_name). Grok's
// Rust Path is host-OS-specific; Orca resolves session paths for local and
// remote/SSH guests, so treating either separator as a segment break keeps the
// slug leaf correct. Blake3 still hashes the full raw cwd string either way.
/** Last path segment using both `/` and `\` so Windows guest cwds match on any host. */
export function grokCwdLeafName(cwd: string): string {
  const withoutTrailing = cwd.replace(/[/\\]+$/u, '')
  if (!withoutTrailing) {
    return 'workspace'
  }
  const parts = withoutTrailing.split(/[/\\]/u)
  const leaf = parts[parts.length - 1]
  return leaf && leaf.length > 0 ? leaf : 'workspace'
}

/**
 * Encode a CWD into Grok's sessions group directory name.
 * Returns null only for empty/invalid inputs (never for "too long" — long paths
 * use the slug+hash form).
 */
export function encodeGrokCwdDirName(cwd: string): string | null {
  const trimmed = cwd.trim()
  if (!trimmed) {
    return null
  }
  let urlEncoded: string
  try {
    urlEncoded = encodeGrokUrlComponent(trimmed)
  } catch {
    return null
  }
  // Reject path-syntax components that would escape the sessions root.
  if (
    urlEncoded === '.' ||
    urlEncoded === '..' ||
    urlEncoded.includes('/') ||
    urlEncoded.includes('\\')
  ) {
    return null
  }
  if (Buffer.byteLength(urlEncoded, 'utf8') <= GROK_ENCODED_CWD_DIR_MAX_BYTES) {
    return urlEncoded
  }
  const hashHex = bytesToHex(blake3(new TextEncoder().encode(trimmed)))
  const hash16 = hashHex.slice(0, BLAKE3_HEX_PREFIX_LEN)
  const slug = slugifyGrokCwdLeaf(grokCwdLeafName(trimmed), SLUG_MAX_CHARS)
  const safeSlug = slug.length > 0 ? slug : 'workspace'
  return `${safeSlug}-${hash16}`
}
