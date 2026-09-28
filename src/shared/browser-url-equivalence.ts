const TIMESTAMP_PARAM_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be'
])

/** True when `t` on this host is a playback timestamp rather than page identity. */
export function isTimestampParameterHost(hostname: string): boolean {
  return TIMESTAMP_PARAM_HOSTS.has(hostname.toLowerCase())
}

export function isEquivalentBrowserPageUrl(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  if (a === b) {
    return true
  }
  try {
    const urlA = new URL(a)
    const urlB = new URL(b)
    if (urlA.origin !== urlB.origin || urlA.pathname !== urlB.pathname || urlA.hash !== urlB.hash) {
      return false
    }
    const paramsA = new URLSearchParams(urlA.search)
    const paramsB = new URLSearchParams(urlB.search)
    if (isTimestampParameterHost(urlA.hostname)) {
      paramsA.delete('t')
      paramsB.delete('t')
    }
    paramsA.sort()
    paramsB.sort()
    return paramsA.toString() === paramsB.toString()
  } catch {
    return false
  }
}
