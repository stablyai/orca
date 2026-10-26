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
