const ZED_LAUNCHER_NAMES = new Set(['zed'])
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\)/i

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function getZedLauncherCommandToken(command: string): string {
  const trimmed = command.trim()
  const quote = trimmed[0]
  if (quote === '"' || quote === "'") {
    const closingIndex = trimmed.indexOf(quote, 1)
    if (closingIndex > 0) {
      return stripMatchingQuotes(trimmed.slice(0, closingIndex + 1))
    }
  }
  return stripMatchingQuotes(trimmed.split(/\s+/, 1)[0] ?? '')
}

export function isZedLauncherExecutable(command: string): boolean {
  const unquoted = stripMatchingQuotes(command)
  const segments = unquoted.split(/[\\/]/)
  const fileName = segments.at(-1) ?? ''
  const launcherName = fileName.replace(/\.(?:cmd|exe|bat)$/i, '').toLowerCase()
  return ZED_LAUNCHER_NAMES.has(launcherName)
}

export function isZedRemoteSshCommand(command: string | undefined): boolean {
  const trimmed = command?.trim()
  if (!trimmed) {
    return false
  }
  const commandToken = getZedLauncherCommandToken(trimmed)
  const unquoted = stripMatchingQuotes(trimmed)
  const isAbsolutePath = commandToken.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(commandToken)
  const hasArguments = unquoted !== commandToken
  if (hasArguments && !isAbsolutePath) {
    return false
  }
  return isZedLauncherExecutable(commandToken)
}
