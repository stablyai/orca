import type { ITerminalOptions } from '@xterm/xterm'

export type WindowsPtyCompatibilityContext = {
  userAgent?: string
  connectionId: string | null | undefined
  cwd?: string | null
  shellOverride?: string | null
}

function isWindowsUserAgent(userAgent: string | undefined): boolean {
  return userAgent?.includes('Windows') ?? false
}

function isWslCwd(cwd: string | null | undefined): boolean {
  return /^(?:\\\\wsl(?:\.localhost)?\\|\/\/wsl(?:\.localhost)?\/)/i.test(cwd ?? '')
}

function isWslShellOverride(shellOverride: string | null | undefined): boolean {
  return /(?:^|[/\\])wsl(?:\.exe)?$/i.test(shellOverride ?? '')
}

export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext
): Partial<ITerminalOptions> {
  if (!isWindowsUserAgent(context.userAgent)) {
    return {}
  }
  if (context.connectionId !== null) {
    return {}
  }
  if (isWslCwd(context.cwd) || isWslShellOverride(context.shellOverride)) {
    return {}
  }
  return {
    // Why: native Windows shells are backed by ConPTY, and xterm's dedicated
    // compatibility heuristics prevent wrap/cursor assumptions from drifting.
    windowsPty: { backend: 'conpty' }
  }
}
