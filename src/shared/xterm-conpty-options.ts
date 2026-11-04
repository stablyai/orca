import type { PtyOwnerBackend } from './pty-owner-backend'

/** xterm `windowsPty` for a ConPTY-backed terminal, shared by the window and the daemon's emulator. */
export type XtermConptyOptions = { backend: 'conpty'; buildNumber?: number }

export function parseWindowsBuildNumber(osRelease: string | null | undefined): number | undefined {
  const build = osRelease?.split('.')[2]
  if (!build) {
    return undefined
  }
  const parsed = Number.parseInt(build, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function buildXtermConptyOptions(buildNumber: number | undefined): XtermConptyOptions {
  // Old ConPTY lacks reliable wrap markers; low build numbers make xterm misclassify full-width rows as wrapped.
  if (buildNumber === undefined || buildNumber < 21376) {
    return { backend: 'conpty' }
  }
  return { backend: 'conpty', buildNumber }
}

/**
 * ConPTY repaints its own grid after a resize, so every emulator of a ConPTY pane (the daemon's,
 * main's copy and the window's) must grow rows without pulling scrollback back into it.
 * Every PTY a Windows host owns is ConPTY, WSL shells included.
 */
export function windowsPtyForOwnerBackend(
  ownerBackend: PtyOwnerBackend | undefined,
  osRelease: string | null | undefined
): XtermConptyOptions | undefined {
  return ownerBackend === undefined || ownerBackend === 'posix-pty'
    ? undefined
    : buildXtermConptyOptions(parseWindowsBuildNumber(osRelease))
}
