export type NetworkProxySettings = {
  httpProxyUrl?: string | null
  httpProxyBypassRules?: string | null
}

export type ProxyUrlValidationResult =
  | { ok: true; value: string; message?: undefined }
  | { ok: false; value: ''; message: string }

const PROXY_URL_MAX_LENGTH = 2048
const PROXY_BYPASS_RULES_MAX_LENGTH = 4096
const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks:', 'socks4:', 'socks5:'])
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'HTTP_PROXY',
  'http_proxy'
] as const
const NO_PROXY_ENV_KEYS = ['NO_PROXY', 'no_proxy'] as const

function formatProxyUrl(url: URL): string {
  const auth =
    url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  return `${url.protocol}//${auth}${url.host}`
}

export function normalizeProxyUrl(value: unknown): ProxyUrlValidationResult {
  if (typeof value !== 'string') {
    return { ok: true, value: '' }
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return { ok: true, value: '' }
  }
  if (trimmed.length > PROXY_URL_MAX_LENGTH) {
    return { ok: false, value: '', message: 'Proxy URL is too long.' }
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, value: '', message: 'Enter a valid proxy URL.' }
  }
  if (!PROXY_PROTOCOLS.has(parsed.protocol)) {
    return {
      ok: false,
      value: '',
      message: 'Use an http, https, socks, socks4, or socks5 proxy URL.'
    }
  }
  if (!parsed.hostname) {
    return { ok: false, value: '', message: 'Proxy URL must include a host.' }
  }
  return { ok: true, value: formatProxyUrl(parsed) }
}

export function normalizeProxyBypassRules(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }
  return value
    .slice(0, PROXY_BYPASS_RULES_MAX_LENGTH)
    .split(/[;,\n]/)
    .map((rule) => rule.trim())
    .filter(Boolean)
    .join(';')
}

export function getProxyUrlFromEnvironment(
  env: Record<string, string | undefined>
): ProxyUrlValidationResult {
  for (const key of PROXY_ENV_KEYS) {
    if (env[key]) {
      return normalizeProxyUrl(env[key])
    }
  }
  return { ok: true, value: '' }
}

export function getProxyBypassRulesFromEnvironment(
  env: Record<string, string | undefined>
): string {
  for (const key of NO_PROXY_ENV_KEYS) {
    if (env[key]) {
      return normalizeProxyBypassRules(env[key])
    }
  }
  return ''
}

export function buildConfiguredProxyEnv(
  settings: NetworkProxySettings | null | undefined
): Record<string, string> {
  const proxy = normalizeProxyUrl(settings?.httpProxyUrl)
  if (!proxy.ok || !proxy.value) {
    return {}
  }
  const env: Record<string, string> = {
    HTTP_PROXY: proxy.value,
    HTTPS_PROXY: proxy.value,
    ALL_PROXY: proxy.value,
    http_proxy: proxy.value,
    https_proxy: proxy.value,
    all_proxy: proxy.value
  }
  const bypassRules = normalizeProxyBypassRules(settings?.httpProxyBypassRules)
  // Why: explicit Orca proxy settings should not accidentally inherit a
  // parent shell's NO_PROXY. The bypass field above is the single source for
  // local child process bypass behavior when a configured proxy is present.
  const noProxy = bypassRules ? bypassRules.replaceAll(';', ',') : ''
  env.NO_PROXY = noProxy
  env.no_proxy = noProxy
  return env
}

export function redactProxyUrl(value: string): string {
  const parsed = normalizeProxyUrl(value)
  if (!parsed.ok || !parsed.value) {
    return parsed.value
  }
  const url = new URL(parsed.value)
  if (url.username || url.password) {
    url.username = '***'
    url.password = url.password ? '***' : ''
  }
  return formatProxyUrl(url)
}
