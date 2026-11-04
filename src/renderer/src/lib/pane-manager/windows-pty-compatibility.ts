import type { ITerminalOptions } from '@xterm/xterm'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  buildXtermConptyOptions,
  parseWindowsBuildNumber,
  windowsPtyForOwnerBackend
} from '../../../../shared/xterm-conpty-options'
import { resolvePtyOwnerBackend, type PtyOwnerBackend } from '../../../../shared/pty-owner-backend'

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

/**
 * xterm's ConPTY model for every pane this Windows machine's daemon owns, WSL shells included: the
 * same owner-backend rule as the daemon's and main's emulators. Native-only workarounds (cursor,
 * CJK, keyboard) stay behind `isLocalNativeWindowsConpty`. executionHostId excludes serve/runtime
 * panes that look local to raw connectionId/cwd heuristics.
 */
export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): Partial<ITerminalOptions> {
  const windowsPty = windowsPtyForOwnerBackend(localPaneOwnerBackend(context), context.osRelease)
  return windowsPty ? { windowsPty } : {}
}

function localPaneOwnerBackend(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): PtyOwnerBackend | undefined {
  if (context.executionHostId !== LOCAL_EXECUTION_HOST_ID || context.connectionId !== null) {
    return undefined
  }
  return resolvePtyOwnerBackend({
    platform: isWindowsUserAgent(context.userAgent) ? 'win32' : 'linux',
    shellPath: context.shellOverride ?? undefined
  })
}

/** Reuse ConPTY options after dashboard preview has already resolved local native-Windows ownership. */
export function buildLocalConptyTerminalOptions(
  osRelease: string | null | undefined
): Partial<ITerminalOptions> {
  return { windowsPty: buildXtermConptyOptions(parseWindowsBuildNumber(osRelease)) }
}

/** Match main’s effectiveShellOverride/isNativeWindowsLocalPtySpawn: tab override wins, else global Windows setting, so global WSL classifies identically. */
export function resolveWindowsShellOverride(
  tabShellOverride: string | null | undefined,
  globalWindowsShell: string | null | undefined
): string | undefined {
  return tabShellOverride ?? globalWindowsShell ?? undefined
}

/**
 * Raw client-side heuristic for a native-Windows ConPTY pane (Windows UA, no SSH
 * connection, non-WSL cwd/shell). Necessary but not sufficient: it cannot tell a
 * local pane from a serve pane, so callers gate it with `isLocalNativeWindowsConpty`.
 */
export function isLocalNativeWindowsPty(context: WindowsPtyCompatibilityContext): boolean {
  return (
    isWindowsUserAgent(context.userAgent) &&
    context.connectionId === null &&
    !isWslCwd(context.cwd) &&
    !isWslShellOverride(context.shellOverride)
  )
}

/** Require local execution host plus native-Windows heuristics. Serve/runtime panes lack SSH IDs and can appear local by cwd, but must not receive ConPTY cursor/synchronized-output workarounds that hide remote agent cursors. */
export function isLocalNativeWindowsConpty(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): boolean {
  return context.executionHostId === LOCAL_EXECUTION_HOST_ID && isLocalNativeWindowsPty(context)
}
