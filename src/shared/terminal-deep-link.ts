// Same alphabet and bound as the terminal's own term_* link detection.
const TERMINAL_PATH_PATTERN = /^\/(term_[A-Za-z0-9_-]{1,128})\/?$/
const MAX_ENVIRONMENT_SELECTOR_LENGTH = 256

/** `environment` names a paired server (`orca environment list` name or id); null means this app. */
export type TerminalDeepLink = {
  handle: string
  environment: string | null
}

/** `orca://terminal/<handle>[?environment=<name|id>]`; anything else, including extra parameters, is rejected. */
export function parseTerminalDeepLink(value: string): TerminalDeepLink | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (
    url.protocol !== 'orca:' ||
    url.host !== 'terminal' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== ''
  ) {
    return null
  }
  const handle = TERMINAL_PATH_PATTERN.exec(url.pathname)?.[1]
  if (!handle) {
    return null
  }
  const keys = [...url.searchParams.keys()]
  if (keys.some((key) => key !== 'environment') || keys.length > 1) {
    return null
  }
  const environment = url.searchParams.get('environment')
  if (
    environment !== null &&
    (environment.length === 0 || environment.length > MAX_ENVIRONMENT_SELECTOR_LENGTH)
  ) {
    return null
  }
  return { handle, environment }
}

export function formatTerminalDeepLink(link: TerminalDeepLink): string {
  const base = `orca://terminal/${link.handle}`
  return link.environment === null
    ? base
    : `${base}?environment=${encodeURIComponent(link.environment)}`
}

export function terminalDeepLinkFromArguments(argv: readonly string[]): TerminalDeepLink | null {
  for (const value of argv) {
    const link = parseTerminalDeepLink(value)
    if (link) {
      return link
    }
  }
  return null
}
