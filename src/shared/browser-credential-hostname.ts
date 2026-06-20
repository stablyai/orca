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
    return new URL(origin).hostname?.toLowerCase() || null
  } catch {
    return null
  }
}
