import type { CliStatusResult, RuntimeStatus } from './runtime-types'

export function resolveDesktopWindowStatus(
  status: RuntimeStatus
): CliStatusResult['app']['desktopWindowStatus'] {
  if (status.desktopWindowStatus) {
    return status.desktopWindowStatus
  }
  // Why: older desktop runtimes predate the explicit status but a positive
  // Electron id still proves that a real window owns the graph.
  return status.authoritativeWindowId !== null && status.authoritativeWindowId > 0
    ? 'available'
    : undefined
}

// Why: a status fetched from another machine describes THAT machine, so `app` must too.
// `available` is the only desktop-window status that requires a live renderer owning the graph,
// which makes it the signal separating a real desktop app from a headless `serve`. Reporting a
// fixed running value while echoing the target's own window status produces a self-contradictory
// result, and readers acted on it — a remote GUI run was written off as headless (STA-4792).
// A pid is not knowable across the boundary, so it stays null.
export function projectRemoteAppStatus(status: RuntimeStatus): CliStatusResult['app'] {
  const desktopWindowStatus = resolveDesktopWindowStatus(status)
  return {
    running: desktopWindowStatus === 'available',
    pid: null,
    ...(desktopWindowStatus ? { desktopWindowStatus } : {})
  }
}
