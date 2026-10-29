/** Pinned Node download mirror changes byte source only; SHA-256 pins still decide acceptance. */

/** The variables Node tooling already reads for the same mirror; read on this computer only. */
export const NODE_DIST_MIRROR_ENV_KEYS = ['NODEJS_ORG_MIRROR', 'NVM_NODEJS_ORG_MIRROR'] as const

export type NodeDistMirrorRefusal = 'too-long' | 'invalid' | 'protocol' | 'credentials' | 'query'

/** `message` is the English text; `reason` lets the renderer word it in the user's language. */
export type NodeDistMirrorValidationResult =
  | { ok: true; value: string; message?: undefined; reason?: undefined }
  | { ok: false; value: ''; message: string; reason: NodeDistMirrorRefusal }

const NODE_DIST_MIRROR_MAX_LENGTH = 2048

/** An http(s) base URL with no query or fragment and no trailing slash; empty means none. */
export function normalizeNodeDistMirrorUrl(value: unknown): NodeDistMirrorValidationResult {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) {
    return { ok: true, value: '' }
  }
  if (trimmed.length > NODE_DIST_MIRROR_MAX_LENGTH) {
    return { ok: false, value: '', message: 'Mirror URL is too long.', reason: 'too-long' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, value: '', message: 'Enter a valid mirror URL.', reason: 'invalid' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      value: '',
      message: 'Use an http or https mirror URL.',
      reason: 'protocol'
    }
  }
  // Why: the URL reaches SSH hosts and error text; credentials belong in the proxy setting.
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      value: '',
      message: 'Mirror URL cannot contain a user name or password.',
      reason: 'credentials'
    }
  }
  if (parsed.search || parsed.hash) {
    return {
      ok: false,
      value: '',
      message: 'Mirror URL cannot have a query or fragment.',
      reason: 'query'
    }
  }
  // Why origin + pathname: href keeps an empty `?` or `#`, which would swallow the archive path.
  return { ok: true, value: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/u, '') }
}

/** The first valid mirror among Orca's setting and the conventional environment variables. */
export function resolveNodeDistMirror(
  setting: string | undefined,
  env: Record<string, string | undefined>
): string | null {
  for (const candidate of [setting, ...NODE_DIST_MIRROR_ENV_KEYS.map((key) => env[key])]) {
    const normalized = normalizeNodeDistMirrorUrl(candidate)
    if (normalized.ok && normalized.value) {
      return normalized.value
    }
  }
  return null
}

/** Whether a failed Node download went through a mirror; `unsupported`: this build has none. */
export type NodeDistMirrorAttempt = 'unset' | 'tried' | 'unsupported'

export function isNodeDistMirrorAttempt(value: unknown): value is NodeDistMirrorAttempt {
  return value === 'unset' || value === 'tried' || value === 'unsupported'
}

export function nodeDistMirrorUrl(mirror: string, version: string, file: string): string {
  return `${mirror}/v${version}/${file}`
}
