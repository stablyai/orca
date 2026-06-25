import type { ITerminalOptions } from '@xterm/xterm'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'

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

/**
 * xterm options that select the native-Windows ConPTY backend, returned only for
 * a genuine local Windows pane and `{}` otherwise.
 *
 * Why it requires `executionHostId`: a serve/remote-runtime pane on a Windows
 * client looks local to the raw heuristic (no SSH `connectionId`, Linux `cwd`),
 * so gating on the execution host keeps the ConPTY backend off remote PTYs.
 */
export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): Partial<ITerminalOptions> {
  if (!isLocalNativeWindowsConpty(context)) {
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

/**
 * Raw client-side heuristic for a native-Windows ConPTY pane (Windows UA, no SSH
 * connection, non-WSL cwd/shell). Necessary but not sufficient: it cannot tell a
 * local pane from a serve pane, so callers gate it with `isLocalNativeWindowsConpty`.
 */
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

/**
 * Whether a pane is a genuine local native Windows ConPTY that needs the ConPTY
 * cursor/synchronized-output workarounds.
 *
 * Why this is gated on the execution host: a serve/remote-runtime pane on a
 * Windows client has no SSH `connectionId` and a Linux `cwd`, so
 * `isLocalNativeWindowsPty` misfires and classifies it as local. The execution
 * host is the authoritative signal: only a `'local'` host is a real local
 * native PTY. Remote panes resolve to `runtime:<env>` (or `ssh:<target>`) and
 * must be excluded, otherwise ConPTY transient cursor-show (`?25h`) stripping is
 * wrongly applied to them and a repainting agent's cursor disappears.
 */
export function isLocalNativeWindowsConpty(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): boolean {
  return context.executionHostId === LOCAL_EXECUTION_HOST_ID && isLocalNativeWindowsPty(context)
}
