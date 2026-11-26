import { normalizeProxyBypassRules, PROXY_ENV_KEYS } from './network-proxy'

/** Set beside a launch's own proxy env so the PTY host does not lay the Settings proxy over it. */
export const ORCA_LAUNCH_PROXY_ENV = 'ORCA_LAUNCH_PROXY'

const WORKER_PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
const WORKER_PROXY_URL_MAX_LENGTH = 2048
// The worker still reaches Orca's agent hooks and any local dev server directly.
const LOOPBACK_NO_PROXY = ['localhost', '127.0.0.1', '::1']

export type WorkerProxyUrlResult = { ok: true; url: URL } | { ok: false; message: string }

/** Messages never echo the value: it may carry credentials. */
export function parseWorkerProxyUrl(value: string): WorkerProxyUrlResult {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > WORKER_PROXY_URL_MAX_LENGTH) {
    return { ok: false, message: '--proxy must be a proxy URL of at most 2048 characters.' }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, message: '--proxy is not a valid URL.' }
  }
  if (!WORKER_PROXY_PROTOCOLS.has(url.protocol)) {
    return { ok: false, message: '--proxy must use http, https, socks5, or socks5h.' }
  }
  if (!url.hostname) {
    return { ok: false, message: '--proxy must include a host.' }
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, message: '--proxy must not include a path, query, or fragment.' }
  }
  return { ok: true, url }
}

function formatWorkerProxyUrl(url: URL, auth: string): string {
  return `${url.protocol}//${auth}${url.host}`
}

/** The proxy as it is safe to print: any user or password becomes `***`. */
export function redactWorkerProxyUrl(value: string): string {
  const parsed = parseWorkerProxyUrl(value)
  if (!parsed.ok) {
    return '<invalid proxy URL>'
  }
  const { url } = parsed
  const auth = url.username || url.password ? `***${url.password ? ':***' : ''}@` : ''
  return formatWorkerProxyUrl(url, auth)
}

/** Every proxy variable common HTTP clients read, pointed at `proxy`, with loopback and `bypass`
 *  (comma, semicolon or newline separated) exempted. A SOCKS URL goes in the HTTP(S) variables too,
 *  as the Settings proxy does; clients that only take an http proxy there ignore or reject it. */
export function buildWorkerProxyEnv(proxy: string, bypass?: string): Record<string, string> {
  const parsed = parseWorkerProxyUrl(proxy)
  if (!parsed.ok) {
    throw new Error(parsed.message)
  }
  const { url } = parsed
  const auth =
    url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : ''
  const value = formatWorkerProxyUrl(url, auth)
  const extra = normalizeProxyBypassRules(bypass).split(';').filter(Boolean)
  const noProxy = [...new Set([...LOOPBACK_NO_PROXY, ...extra])].join(',')
  return {
    ...Object.fromEntries(PROXY_ENV_KEYS.map((key) => [key, value])),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    [ORCA_LAUNCH_PROXY_ENV]: '1'
  }
}
