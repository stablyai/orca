import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS,
  type SshTarget
} from '../../../../shared/ssh-types'

export type EditingTarget = {
  label: string
  configHost: string
  host: string
  port: string
  username: string
  identityFile: string
  proxyCommand: string
  jumpHost: string
  relayGracePeriodSeconds: string
  relayKeepAliveUntilReset: boolean
}

export const EMPTY_FORM: EditingTarget = {
  label: '',
  configHost: '',
  host: '',
  port: '22',
  username: '',
  identityFile: '',
  proxyCommand: '',
  jumpHost: '',
  relayGracePeriodSeconds: String(DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS),
  relayKeepAliveUntilReset: false
}

export function getEditingTargetForSshTarget(target: SshTarget): EditingTarget {
  // Why: manual targets store configHost as their host. Clear that implicit
  // value on edit so changing Host recomputes the alias instead of keeping stale resolution.
  const configHost = target.configHost && target.configHost !== target.host ? target.configHost : ''
  return {
    label: target.label,
    configHost,
    host: target.host,
    port: String(target.port),
    username: target.username,
    identityFile: target.identityFile ?? '',
    proxyCommand: target.proxyCommand ?? '',
    jumpHost: target.jumpHost ?? '',
    relayGracePeriodSeconds: String(
      target.relayGracePeriodSeconds === 0
        ? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS
        : (target.relayGracePeriodSeconds ?? DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS)
    ),
    relayKeepAliveUntilReset: target.relayGracePeriodSeconds === 0
  }
}

export type ParsedSshHostInput = {
  host: string
  username?: string
  port?: number
  invalidPort?: boolean
  configHost: string
}

export function parseSshHostInput(rawInput: string): ParsedSshHostInput | null {
  const input = rawInput.trim()
  if (!input) {
    return null
  }

  if (/^ssh:\/\//i.test(input)) {
    return parseSshUrl(input)
  }

  const atIndex = input.lastIndexOf('@')
  const username = atIndex > 0 ? input.slice(0, atIndex).trim() : undefined
  const hostPort = atIndex > 0 ? input.slice(atIndex + 1).trim() : input
  const parsed = parseHostAndOptionalPort(hostPort)
  if (!parsed.host) {
    return null
  }

  return {
    host: parsed.host,
    username,
    port: parsed.port,
    invalidPort: parsed.invalidPort,
    configHost: parsed.host
  }
}

export function applyParsedSshHostInput(draft: EditingTarget): EditingTarget {
  const parsed = parseSshHostInput(draft.host)
  // Why: keep bad host:port text visible so the user can correct it after
  // the save validator reports the invalid port.
  if (!parsed || parsed.invalidPort) {
    return draft
  }

  return {
    ...draft,
    host: parsed.host,
    configHost: draft.configHost.trim() || parsed.configHost,
    username: draft.username.trim() || parsed.username || '',
    port:
      parsed.port !== undefined && isDefaultPortDraft(draft.port) ? String(parsed.port) : draft.port
  }
}

export function getSshTargetDraftConnectionFields(draft: EditingTarget): {
  host: string
  configHost: string
  username: string
  port: number
} {
  const parsed = parseSshHostInput(draft.host)
  const host = parsed?.host ?? draft.host.trim()
  const configHost = draft.configHost.trim() || parsed?.configHost || host
  const username = draft.username.trim() || parsed?.username || ''
  const parsedPort = parseInt(draft.port, 10)
  const port =
    parsed?.invalidPort === true
      ? Number.NaN
      : parsed?.port !== undefined && isDefaultPortDraft(draft.port)
        ? parsed.port
        : parsedPort

  return {
    host,
    configHost,
    username,
    port
  }
}

export function parseRelayGracePeriodSeconds(draft: EditingTarget): number {
  return draft.relayKeepAliveUntilReset ? 0 : parseInt(draft.relayGracePeriodSeconds, 10)
}

export function isRelayGracePeriodValid(draft: EditingTarget, graceSeconds: number): boolean {
  return (
    draft.relayKeepAliveUntilReset ||
    (!isNaN(graceSeconds) &&
      graceSeconds >= MIN_SSH_RELAY_GRACE_PERIOD_SECONDS &&
      graceSeconds <= MAX_SSH_RELAY_GRACE_PERIOD_SECONDS)
  )
}

function parseSshUrl(input: string): ParsedSshHostInput | null {
  try {
    const url = new URL(input)
    if (url.protocol !== 'ssh:' || !url.hostname) {
      return null
    }
    // Why: URL.hostname keeps IPv6 literals bracketed, but ssh2 and DNS
    // resolution expect the bare address. The non-URL parser already strips.
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const port = url.port ? parsePort(url.port) : undefined
    if (url.port && port === undefined) {
      return {
        host,
        username: decodeSshUrlUsername(url.username),
        configHost: host,
        invalidPort: true
      }
    }
    return {
      host,
      username: decodeSshUrlUsername(url.username),
      port,
      configHost: host
    }
  } catch {
    return parseSshUrlWithInvalidPort(input)
  }
}

function parseSshUrlWithInvalidPort(input: string): ParsedSshHostInput | null {
  const match = input.match(/^ssh:\/\/(?:([^@/?#]*)@)?(\[[^\]]+\]|[^:/?#]+):([^/?#]*)(?:[/?#]|$)/i)
  if (!match) {
    return null
  }

  const rawHost = match[2]
  const host = rawHost.startsWith('[') && rawHost.endsWith(']') ? rawHost.slice(1, -1) : rawHost
  const port = parsePort(match[3])
  if (port !== undefined) {
    return null
  }

  return {
    host,
    username: decodeSshUrlUsername(match[1] ?? ''),
    configHost: host,
    invalidPort: true
  }
}

function decodeSshUrlUsername(value: string): string | undefined {
  if (!value) {
    return undefined
  }
  try {
    return decodeURIComponent(value)
  } catch {
    // Why: malformed pasted SSH URLs should surface validation errors in the
    // form, not throw during parsing before the user can fix the input.
    return value
  }
}

function parseHostAndOptionalPort(input: string): {
  host: string
  port?: number
  invalidPort?: boolean
} {
  if (input.startsWith('[')) {
    const closeIndex = input.indexOf(']')
    if (closeIndex > 1) {
      const host = input.slice(1, closeIndex)
      const suffix = input.slice(closeIndex + 1)
      if (suffix.startsWith(':')) {
        const port = parsePort(suffix.slice(1))
        return port === undefined ? { host, invalidPort: true } : { host, port }
      }
      return { host }
    }
  }

  const firstColon = input.indexOf(':')
  if (firstColon !== -1 && firstColon === input.lastIndexOf(':')) {
    const host = input.slice(0, firstColon)
    const port = parsePort(input.slice(firstColon + 1))
    if (host) {
      return port === undefined ? { host, invalidPort: true } : { host, port }
    }
  }

  return { host: input }
}

function parsePort(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined
  }
  const port = Number(value)
  return isValidPort(port) ? port : undefined
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function isDefaultPortDraft(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '22'
}
