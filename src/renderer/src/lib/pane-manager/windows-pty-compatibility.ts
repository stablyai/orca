import type { ITerminalOptions } from '@xterm/xterm'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  buildXtermConptyOptions,
  parseWindowsBuildNumber
} from '../../../../shared/xterm-conpty-options'

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

/** Apply ConPTY options only to genuine local Windows panes. executionHostId excludes serve/runtime panes that look local to raw connectionId/cwd heuristics. */
export function buildWindowsPtyCompatibilityOptions(
  context: WindowsPtyCompatibilityContext & { executionHostId: ExecutionHostId }
): Partial<ITerminalOptions> {
  if (!isLocalNativeWindowsConpty(context)) {
    return {}
  }
  return buildLocalConptyTerminalOptions(context.osRelease)
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
