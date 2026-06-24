// Why: credentials match by host only (Spec: "shared, matched by hostname"), but
// http vs https must stay distinct so a downgraded page can't borrow https creds.
const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

export function normalizeCredentialOrigin(input: string): string | null {
  try {
    const url = new URL(input)
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
      return null
    }
    if (!url.hostname) {
      return null
    }
    return `${url.protocol}//${url.hostname.toLowerCase()}`
  } catch {
    return null
  }
}

export function hostnameFromOrigin(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (!ALLOWED_SCHEMES.has(url.protocol)) {
      return null
    }
    const hostname = url.hostname
    if (!hostname) {
      return null
    }
    return hostname.toLowerCase()
  } catch {
    return null
  }
}
