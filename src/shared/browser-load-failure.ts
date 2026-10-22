// English copy lives here so desktop (translating each piece) and mobile never say different things.

import type { BrowserLoadError } from './browser-workspace-types'
import { classifyRemotePairingHostname } from './remote-pairing-address'
import { isWildcardBindHost } from './browser-url'
import { isChromiumCertificateErrorCode } from './browser-certificate-errors'

export type BrowserLoadFailureKind =
  | 'not-running'
  | 'refused'
  | 'dns'
  | 'offline'
  | 'timeout'
  | 'reset'
  | 'route-down'
  | 'other'

/** `poll`: re-attempt the load with backoff. `online`: re-attempt when the network returns. */
export type BrowserLoadFailureRecovery = 'poll' | 'online' | null

export type BrowserLoadFailureDescription = {
  kind: BrowserLoadFailureKind
  /** `hostname:port` as the page asked for it, or null when the URL has none. */
  host: string | null
  recovery: BrowserLoadFailureRecovery
  /** Chromium's name for the error (ERR_CONNECTION_REFUSED), for the small developer line. */
  errorName: string | null
}

/**
 * How the page reaches the network: directly, or through the workspace's SSH host and whether that
 * host is connected. Null when the caller can't tell (mobile, client-hosted pages).
 */
export type BrowserLoadFailureRoute = { routed: false } | { routed: true; routeConnected: boolean }

export const BROWSER_LOAD_FAILURE_COPY = {
  notRunningTitle: 'Nothing is running on {{host}} yet',
  notRunningDescription: 'Start the dev server for this address to see the page.',
  refusedTitle: '{{host}} refused to connect',
  refusedDescription: 'The site may be down, or the address may be wrong.',
  dnsTitle: "Couldn't find {{host}}",
  dnsDescription: 'Check the address for typos.',
  offlineTitle: "You're offline",
  offlineDescription: 'Check your network connection.',
  timeoutTitle: '{{host}} took too long to respond',
  timeoutDescription: 'The server may be busy or unreachable.',
  resetTitle: 'The connection to {{host}} was interrupted',
  resetDescription: 'The server closed the connection before the page loaded.',
  routeDownTitle: "Can't reach the SSH host",
  routeDownDescription:
    "This page loads through the workspace's SSH host, which isn't connected right now.",
  otherTitle: "Can't reach {{host}}",
  otherTitleWithoutHost: "Can't load this page",
  otherDescription: "We couldn't connect to this page.",
  waiting: 'Waiting for the server… reloads automatically',
  waitingForHost: 'Waiting for the SSH host… reloads automatically',
  waitingForNetwork: "Reloads when you're back online",
  stopWaiting: 'Stop'
} as const

export type BrowserLoadFailureCopyId = keyof typeof BROWSER_LOAD_FAILURE_COPY

const KIND_COPY: Record<
  BrowserLoadFailureKind,
  { title: BrowserLoadFailureCopyId; description: BrowserLoadFailureCopyId }
> = {
  'not-running': { title: 'notRunningTitle', description: 'notRunningDescription' },
  refused: { title: 'refusedTitle', description: 'refusedDescription' },
  dns: { title: 'dnsTitle', description: 'dnsDescription' },
  offline: { title: 'offlineTitle', description: 'offlineDescription' },
  timeout: { title: 'timeoutTitle', description: 'timeoutDescription' },
  reset: { title: 'resetTitle', description: 'resetDescription' },
  'route-down': { title: 'routeDownTitle', description: 'routeDownDescription' },
  other: { title: 'otherTitle', description: 'otherDescription' }
}

export type BrowserLoadFailureCopyRender = (
  id: BrowserLoadFailureCopyId,
  values: { host: string }
) => string

const renderEnglish: BrowserLoadFailureCopyRender = (id, values) =>
  BROWSER_LOAD_FAILURE_COPY[id].replace('{{host}}', values.host)

/** The headline and sentence for a failure; desktop passes a translating `render`. */
export function formatBrowserLoadFailureText(
  loadError: BrowserLoadError,
  failure: BrowserLoadFailureDescription,
  render: BrowserLoadFailureCopyRender = renderEnglish
): { title: string; description: string } {
  const copy = KIND_COPY[failure.kind]
  const host = failure.host ?? ''
  return {
    title:
      failure.host || failure.kind !== 'other'
        ? render(copy.title, { host })
        : render('otherTitleWithoutHost', { host }),
    // Why: code 0 carries Orca's own message (bad address, workspace doc, remote browser).
    description: loadError.code === 0 ? loadError.description : render(copy.description, { host })
  }
}

const REFUSED = -102
const OFFLINE = -106
const DNS_CODES = [-105, -137]
const TIMEOUT_CODES = [-7, -118]
const RESET_CODES = [-100, -101, -103, -324]
// Why: every SOCKS failure is one code, so on the SSH route only the host's state tells "not listening" from "host gone".
const PROXY_CODES = [-120, -121, -130]
// Why: reloads can't fix certificate, blocked or HTTP errors (Chrome's auto-reload skips them too).
const RETRYABLE_CODES = new Set([
  REFUSED,
  ...DNS_CODES,
  ...TIMEOUT_CODES,
  ...RESET_CODES,
  ...PROXY_CODES,
  -21, // ERR_NETWORK_CHANGED
  -104, // ERR_CONNECTION_FAILED
  -109 // ERR_ADDRESS_UNREACHABLE
])

/** Hosts a developer runs themselves: this machine, the LAN, the tailnet, or a dev-only name. */
function readHost(url: string): { host: string | null; isDevHost: boolean } {
  try {
    const { host, hostname } = new URL(url)
    if (!hostname) {
      return { host: null, isDevHost: false }
    }
    const isDevHost =
      isWildcardBindHost(hostname) ||
      /\.(?:local|test|internal|lan)$/i.test(hostname) ||
      classifyRemotePairingHostname(hostname) !== 'public'
    return { host, isDevHost }
  } catch {
    return { host: null, isDevHost: false }
  }
}

function classifyKind(
  code: number,
  isDevHost: boolean,
  route: BrowserLoadFailureRoute | null
): BrowserLoadFailureKind {
  if (code === REFUSED) {
    return isDevHost ? 'not-running' : 'refused'
  }
  if (code === OFFLINE) {
    return 'offline'
  }
  if (DNS_CODES.includes(code)) {
    return 'dns'
  }
  if (TIMEOUT_CODES.includes(code)) {
    return 'timeout'
  }
  if (RESET_CODES.includes(code)) {
    return 'reset'
  }
  if (PROXY_CODES.includes(code) && route?.routed) {
    if (!route.routeConnected) {
      return 'route-down'
    }
    return isDevHost ? 'not-running' : 'other'
  }
  return 'other'
}

export function describeBrowserLoadFailure(
  loadError: BrowserLoadError,
  route: BrowserLoadFailureRoute | null
): BrowserLoadFailureDescription {
  const { host, isDevHost } = readHost(loadError.validatedUrl)
  const kind = classifyKind(loadError.code, isDevHost, route)
  const recovery: BrowserLoadFailureRecovery =
    kind === 'offline'
      ? 'online'
      : RETRYABLE_CODES.has(loadError.code) &&
          (isDevHost || kind === 'refused' || kind === 'route-down')
        ? 'poll'
        : null
  return {
    kind,
    host,
    recovery,
    errorName: /^(?:net::)?(ERR_[A-Z_]+)$/.exec(loadError.description)?.[1] ?? null
  }
}

/** Chromium's net errors run from -1 to -999; certificate errors and Orca's own codes have their own pages. */
export function isBrowserNetworkLoadFailure(loadError: BrowserLoadError): boolean {
  return (
    loadError.code < 0 && loadError.code > -1000 && !isChromiumCertificateErrorCode(loadError.code)
  )
}

export function browserLoadErrorsEqual(
  a: BrowserLoadError | null | undefined,
  b: BrowserLoadError | null | undefined
): boolean {
  const left = a ?? null
  const right = b ?? null
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return (
    left.code === right.code &&
    left.description === right.description &&
    left.validatedUrl === right.validatedUrl
  )
}
