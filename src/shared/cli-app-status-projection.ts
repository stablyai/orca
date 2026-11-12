import type { CliStatusResult, RuntimeStatus } from './runtime-types'

export function resolveDesktopWindowStatus(
  status: RuntimeStatus
): CliStatusResult['app']['desktopWindowStatus'] {
  if (status.desktopWindowStatus) {
    return status.desktopWindowStatus
  }
  // Older runtimes omit explicit status; a positive Electron window ID still proves graph ownership.
  return status.authoritativeWindowId !== null && status.authoritativeWindowId > 0
    ? 'available'
    : undefined
}

// Remote status describes the target app: only available proves a live graph-owning renderer, distinguishing desktop from headless serve (STA-4792). Remote PID remains unknown.
export function projectRemoteAppStatus(status: RuntimeStatus): CliStatusResult['app'] {
  const desktopWindowStatus = resolveDesktopWindowStatus(status)
  return {
    running: desktopWindowStatus === 'available',
    pid: null,
    ...(desktopWindowStatus ? { desktopWindowStatus } : {})
  }
}
