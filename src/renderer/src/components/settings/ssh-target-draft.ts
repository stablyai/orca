import {
  DEFAULT_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MAX_SSH_RELAY_GRACE_PERIOD_SECONDS,
  MIN_SSH_RELAY_GRACE_PERIOD_SECONDS
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

export type ParsedSshHostInput = {
  host: string
  username?: string
  port?: number
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
    configHost: parsed.host
  }
}

export function applyParsedSshHostInput(draft: EditingTarget): EditingTarget {
  const parsed = parseSshHostInput(draft.host)
  if (!parsed) {
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
    parsed?.port !== undefined && isDefaultPortDraft(draft.port) ? parsed.port : parsedPort

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
    const port = url.port ? parseInt(url.port, 10) : undefined
    if (port !== undefined && !isValidPort(port)) {
      return null
    }
    return {
      host: url.hostname,
      username: url.username ? decodeURIComponent(url.username) : undefined,
      port,
      configHost: url.hostname
    }
  } catch {
    return null
  }
}

function parseHostAndOptionalPort(input: string): { host: string; port?: number } {
  if (input.startsWith('[')) {
    const closeIndex = input.indexOf(']')
    if (closeIndex > 1) {
      const host = input.slice(1, closeIndex)
      const suffix = input.slice(closeIndex + 1)
      if (suffix.startsWith(':')) {
        const port = parsePort(suffix.slice(1))
        return port === undefined ? { host } : { host, port }
      }
      return { host }
    }
  }

  const portMatch = input.match(/^([^:]+):(\d{1,5})$/)
  if (portMatch) {
    const port = parsePort(portMatch[2])
    return port === undefined ? { host: input } : { host: portMatch[1], port }
  }

  return { host: input }
}

function parsePort(value: string): number | undefined {
  const port = parseInt(value, 10)
  return isValidPort(port) ? port : undefined
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

function isDefaultPortDraft(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '22'
}
