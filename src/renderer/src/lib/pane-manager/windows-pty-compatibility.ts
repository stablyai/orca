import type { ITerminalOptions } from '@xterm/xterm'
import { isWslUncPath } from '../../../../shared/wsl-paths'

export type WindowsPtyCompatibilityContext = {
  userAgent?: string
  osRelease?: string
  connectionId: string | null | undefined
  cwd?: string | null
  shellOverride?: string | null
}

function isWindowsUserAgent(userAgent: string | undefined): boolean {
  return userAgent?.includes('Windows') ?? false
}

function isWslCwd(cwd: string | null | undefined): boolean {
  return isWslUncPath(cwd ?? '')
}

function isWslShellOverride(shellOverride: string | null | undefined): boolean {
  return /(?:^|[/\\])wsl(?:\.exe)?$/i.test(shellOverride ?? '')
}

function parseWindowsBuildNumber(osRelease: string | null | undefined): number | undefined {
  const build = osRelease?.split('.')[2]
  if (!build) {
    return undefined
  }
  const parsed = Number.parseInt(build, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext
): Partial<ITerminalOptions> {
  if (!isLocalNativeWindowsPty(context)) {
    return {}
  }
  const buildNumber = parseWindowsBuildNumber(context.osRelease)
  return {
    // Why: native Windows shells are backed by ConPTY, and xterm's dedicated
    // compatibility heuristics need the OS build to choose the right wrap path.
    windowsPty:
      buildNumber === undefined ? { backend: 'conpty' } : { backend: 'conpty', buildNumber }
  }
}

export function isLocalNativeWindowsPty(context: WindowsPtyCompatibilityContext): boolean {
  if (!isWindowsUserAgent(context.userAgent)) {
    return false
  }
  if (context.connectionId !== null) {
    return false
  }
  if (isWslCwd(context.cwd) || isWslShellOverride(context.shellOverride)) {
    return false
  }
  return true
}
