export function cleanCloudServiceUrl(
  value: string | undefined,
  allowLoopbackHttp: boolean
): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    const loopbackHost =
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '[::1]'
    if (
      parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && loopbackHost && allowLoopbackHttp)
    ) {
      return null
    }
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function cleanCloudServiceOrigin(
  value: string | undefined,
  allowLoopbackHttp: boolean
): string | null {
  const cleaned = cleanCloudServiceUrl(value, allowLoopbackHttp)
  if (!cleaned) {
    return null
  }
  const parsed = new URL(cleaned)
  return parsed.pathname === '/' && !parsed.search && !parsed.hash ? parsed.origin : null
}
