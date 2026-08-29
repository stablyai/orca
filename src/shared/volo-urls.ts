export const DEFAULT_VOLO_API_URL = 'https://volo.api.jaak.ai'
export const DEFAULT_VOLO_WEB_URL = 'https://volo.jaak.ai'

const VOLO_TASK_PATH_RE = /\/t\/([A-Z][A-Z0-9]*-\d+)/i

export function normalizeVoloApiUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error('Enter a Volo API URL.')
  }
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(withProtocol)
  } catch {
    throw new Error('Enter a valid Volo API URL.')
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '127.0.0.1'
  ) {
    throw new Error('Volo API URL must use HTTPS.')
  }
  parsed.hash = ''
  parsed.search = ''
  const normalized = parsed.toString().replace(/\/+$/, '')
  return normalized
}

export function deriveVoloWebUrl(apiUrl: string): string {
  try {
    const parsed = new URL(apiUrl)
    if (parsed.hostname === 'volo.api.jaak.ai') {
      return DEFAULT_VOLO_WEB_URL
    }
    if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') {
      return `${parsed.protocol}//${parsed.hostname}:4200`
    }
    if (parsed.hostname.startsWith('volo.api.')) {
      return `${parsed.protocol}//volo.${parsed.hostname.slice('volo.api.'.length)}`
    }
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return DEFAULT_VOLO_WEB_URL
  }
}

export function voloTaskWebUrl(webUrl: string, taskCode: string): string {
  const origin = webUrl.replace(/\/+$/, '')
  return `${origin}/t/${taskCode}`
}

export function parseVoloTaskUrl(url: string): { origin: string; taskCode: string } | null {
  try {
    const parsed = new URL(url)
    const match = VOLO_TASK_PATH_RE.exec(parsed.pathname)
    if (!match) {
      return null
    }
    return { origin: parsed.origin, taskCode: match[1].toUpperCase() }
  } catch {
    const match = VOLO_TASK_PATH_RE.exec(url)
    return match ? { origin: '', taskCode: match[1].toUpperCase() } : null
  }
}

export function isVoloTaskUrl(url: string): boolean {
  return parseVoloTaskUrl(url) !== null
}
