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
  | 'blocked'
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

/** Direct or workspace-SSH route with host connectivity; null when mobile/client-hosted callers cannot tell. */
export type BrowserLoadFailureRoute = { routed: false } | { routed: true; routeConnected: boolean }

export const BROWSER_LOAD_FAILURE_COPY = {
  notRunningTitle: 'Nothing is running on {{host}} yet',
  notRunningDescription: 'Start the dev server for this address.',
  notRunningSshDescription: "Start the dev server on the workspace's SSH host.",
  refusedTitle: '{{host}} refused to connect',
  refusedDescription: 'The site may be down, or the address may be wrong.',
  dnsTitle: "Couldn't find {{host}}",
  dnsDescription: 'Check the address for typos.',
  offlineTitle: "You're offline",
  timeoutTitle: '{{host}} took too long to respond',
  resetTitle: 'The connection to {{host}} was interrupted',
  routeDownTitle: "Can't reach the SSH host",
  routeDownDescription:
    "This page loads through the workspace's SSH host, which isn't connected right now.",
  blockedTitle: '{{host}} is blocked',
  blockedDescription:
    'An extension blocked this page. To open it, allow this site in the extension, then retry.',
  otherTitle: "Can't reach {{host}}",
  otherTitleWithoutHost: "Can't load this page",
  waiting: 'Reloads when the server responds',
  waitingForServer: 'Reloads when the server starts',
  waitingForHost: 'Reloads when the SSH host reconnects',
  waitingForNetwork: "Reloads when you're back online"
} as const

export type BrowserLoadFailureCopyId = keyof typeof BROWSER_LOAD_FAILURE_COPY

const KIND_COPY: Record<
  BrowserLoadFailureKind,
  { title: BrowserLoadFailureCopyId; description: BrowserLoadFailureCopyId | null }
> = {
  'not-running': { title: 'notRunningTitle', description: 'notRunningDescription' },
  refused: { title: 'refusedTitle', description: 'refusedDescription' },
  dns: { title: 'dnsTitle', description: 'dnsDescription' },
  offline: { title: 'offlineTitle', description: null },
  timeout: { title: 'timeoutTitle', description: null },
  reset: { title: 'resetTitle', description: null },
  'route-down': { title: 'routeDownTitle', description: 'routeDownDescription' },
  blocked: { title: 'blockedTitle', description: 'blockedDescription' },
  other: { title: 'otherTitle', description: null }
}

export type BrowserLoadFailureCopyRender = (
  id: BrowserLoadFailureCopyId,
  values: { host: string }
) => string

const renderEnglish: BrowserLoadFailureCopyRender = (id, values) =>
  BROWSER_LOAD_FAILURE_COPY[id].replace('{{host}}', values.host)

/** The headline, and a sentence only when it adds something the title doesn't; desktop translates. */
export function formatBrowserLoadFailureText(
  loadError: BrowserLoadError,
  failure: BrowserLoadFailureDescription,
  render: BrowserLoadFailureCopyRender = renderEnglish
): { title: string; description: string | null } {
  const copy = KIND_COPY[failure.kind]
  const host = failure.host ?? ''
  return {
    title:
      failure.host || failure.kind !== 'other'
        ? render(copy.title, { host })
        : render('otherTitleWithoutHost', { host }),
    // Why: code 0 carries Orca's own message (bad address, workspace doc, remote browser).
    description:
      loadError.code === 0
        ? loadError.description
        : copy.description && render(copy.description, { host })
  }
}

const REFUSED = -102
// ERR_BLOCKED_BY_CLIENT: an extension's blocking rule cancelled the load.
const BLOCKED_BY_EXTENSION = -20
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
  if (code === BLOCKED_BY_EXTENSION) {
    return 'blocked'
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

export function isBrowserLoadBlockedByExtension(loadError: BrowserLoadError): boolean {
  return loadError.code === BLOCKED_BY_EXTENSION
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
