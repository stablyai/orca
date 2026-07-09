export type TerminalDefaultShellValidationCode =
  | 'not-posix-absolute'
  | 'not-found'
  | 'not-file'
  | 'not-executable'
  | 'not-recognized-shell'
  | 'unsupported-platform'

export type TerminalDefaultShellValidationResult =
  | { ok: true; shellPath: string | null }
  | { ok: false; code: TerminalDefaultShellValidationCode; message: string }

export function normalizeTerminalDefaultShellPath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  return isAbsoluteTerminalShellPath(trimmed) ? trimmed : null
}

export function isAbsoluteTerminalShellPath(shellPath: string): boolean {
  // Why: persisted shell overrides must name the executable explicitly; PATH
  // lookup would make terminal launches depend on mutable process environment.
  return shellPath.startsWith('/')
}

type TerminalDefaultShellOverrideOptions = {
  onInvalid?: 'ignore' | 'throw'
}

export function getTerminalDefaultShellOverride(
  value: unknown,
  options: TerminalDefaultShellOverrideOptions = {}
): string | undefined {
  const normalized = normalizeTerminalDefaultShellPath(value)
  if (normalized) {
    return normalized
  }
  if (options.onInvalid === 'throw' && typeof value === 'string' && value.trim().length > 0) {
    assertAbsoluteTerminalShellPath(value.trim())
  }
  return undefined
}

export function assertAbsoluteTerminalShellPath(shellPath: string): void {
  if (!isAbsoluteTerminalShellPath(shellPath)) {
    throw new Error('Default terminal shell must be a POSIX absolute path')
  }
}
