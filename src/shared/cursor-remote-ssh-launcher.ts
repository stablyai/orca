const CURSOR_LAUNCHER_PATTERN = /^cursor(?:\.(?:cmd|exe))?$/i
const WINDOWS_ABSOLUTE_PATH = /^(?:[a-z]:[\\/]|\\\\)/i

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function isCursorLauncherExecutable(command: string): boolean {
  const unquoted = stripMatchingQuotes(command)
  const segments = unquoted.split(/[\\/]/)
  const fileName = segments.at(-1) ?? ''
  return CURSOR_LAUNCHER_PATTERN.test(fileName)
}

export function isCursorRemoteSshCommand(command: string | undefined): boolean {
  const trimmed = command?.trim()
  if (!trimmed) {
    return false
  }
  const unquoted = stripMatchingQuotes(trimmed)
  const isAbsolutePath = unquoted.startsWith('/') || WINDOWS_ABSOLUTE_PATH.test(unquoted)
  const hasPathSeparator = /[\\/]/.test(unquoted)
  if ((hasPathSeparator || /\s/.test(unquoted)) && !isAbsolutePath) {
    return false
  }
  return isCursorLauncherExecutable(unquoted)
}
