import {
  createShellReadyMarkerScanState,
  scanForShellReadyMarker
} from '@/components/terminal-pane/shell-ready-marker-scan'

const SSH_SHELL_READY_STARTUP_FALLBACK_MS = 1500

type SshBackgroundStartupDeliveryOptions = {
  command: string | null
  waitForShellReady: boolean
  write: (ptyId: string, data: string) => void
}

export type SshBackgroundStartupDelivery = {
  handleData(data: string): string
  schedule(ptyId: string): void
  clear(): void
}

export function createSshBackgroundStartupDelivery(
  options: SshBackgroundStartupDeliveryOptions
): SshBackgroundStartupDelivery {
  let pendingCommand = options.command
  let lastPtyId: string | null = null
  let startupShellReady = !options.waitForShellReady
  const markerScan = options.waitForShellReady ? createShellReadyMarkerScanState() : null
  let injectTimer: ReturnType<typeof setTimeout> | null = null
  let fallbackTimer: ReturnType<typeof setTimeout> | null = null

  const clearInjectTimer = (): void => {
    if (injectTimer !== null) {
      clearTimeout(injectTimer)
      injectTimer = null
    }
  }
  const clearFallbackTimer = (): void => {
    if (fallbackTimer !== null) {
      clearTimeout(fallbackTimer)
      fallbackTimer = null
    }
  }
  function markShellReady(): void {
    if (startupShellReady) {
      return
    }
    startupShellReady = true
    clearFallbackTimer()
    if (pendingCommand && lastPtyId) {
      schedule(lastPtyId)
    }
  }

  const schedule = (ptyId: string): void => {
    lastPtyId = ptyId
    if (!pendingCommand) {
      return
    }
    if (!startupShellReady) {
      if (fallbackTimer === null) {
        // Why: hidden SSH sessions can use shells that cannot emit Orca's
        // marker. Prefer readiness, but never drop the startup command forever.
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null
          markShellReady()
        }, SSH_SHELL_READY_STARTUP_FALLBACK_MS)
      }
      return
    }
    clearInjectTimer()
    injectTimer = setTimeout(() => {
      injectTimer = null
      const command = pendingCommand
      if (!command) {
        return
      }
      pendingCommand = null
      // Why: the SSH relay treats spawn.command as metadata for interactive
      // PTYs; hidden automation tabs still submit the command themselves.
      const submittedCommand =
        command.endsWith('\r') || command.endsWith('\n') ? command : `${command}\r`
      options.write(ptyId, submittedCommand)
    }, 50)
  }

  return {
    handleData(data) {
      if (!markerScan) {
        return data
      }
      const scanned = scanForShellReadyMarker(markerScan, data)
      if (scanned.matched) {
        markShellReady()
      }
      return scanned.output
    },
    schedule,
    clear() {
      clearInjectTimer()
      clearFallbackTimer()
      pendingCommand = null
      lastPtyId = null
    }
  }
}
