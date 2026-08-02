import {
  createShellReadyMarkerScanState,
  scanForShellReadyMarker
} from '@/components/terminal-pane/shell-ready-marker-scan'
import { buildStartupCommandSubmission } from '../../../shared/startup-command-submission'

const SSH_SHELL_READY_STARTUP_FALLBACK_MS = 1500
// Why: a remote shell that has not emitted a single byte is still booting —
// /etc/profile plus nvm/conda/pyenv over a cold link routinely needs more than
// the post-output deadline. Force-delivering there writes the bracketed-paste
// command before readline arms it, so a silent-since-spawn shell gets a longer
// budget; the short deadline applies once output proves the shell is talking.
const SSH_SHELL_READY_NO_OUTPUT_FALLBACK_MS = 15_000

type SshBackgroundStartupDeliveryOptions = {
  command: string | null
  waitForShellReady: boolean
  write: (ptyId: string, data: string) => void
}

export type SshBackgroundStartupDelivery = {
  handleData(data: string): string
  armFallback(ptyId: string): void
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
  let sawOutput = false

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

  const armFallback = (ptyId: string): void => {
    lastPtyId = ptyId
    if (!pendingCommand || fallbackTimer !== null) {
      return
    }
    // The long budget only buys time for the shell-ready marker; the fast path
    // pastes nothing prompt-sensitive, so delaying it there is pure latency.
    const waitingForSilentShell = options.waitForShellReady && !sawOutput
    fallbackTimer = setTimeout(
      () => {
        fallbackTimer = null
        startupShellReady = true
        schedule(ptyId)
      },
      waitingForSilentShell
        ? SSH_SHELL_READY_NO_OUTPUT_FALLBACK_MS
        : SSH_SHELL_READY_STARTUP_FALLBACK_MS
    )
  }

  const schedule = (ptyId: string): void => {
    lastPtyId = ptyId
    if (!pendingCommand) {
      return
    }
    if (!startupShellReady) {
      armFallback(ptyId)
      return
    }
    clearFallbackTimer()
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
      // Why bracketed paste: multiline prompts are pasted literally only when we
      // synchronized on the Orca shell-ready marker (waitForShellReady) — that
      // is the bash/zsh overlay with bracketed-paste mode armed. Submit with CR
      // since the relay drives a remote shell.
      options.write(
        ptyId,
        buildStartupCommandSubmission(command, {
          submit: '\r',
          bracketedPasteSafe: options.waitForShellReady
        })
      )
    }, 50)
  }

  return {
    handleData(data) {
      // First byte proves the shell is talking, so the spawn-time long budget
      // collapses back to the original post-output deadline.
      if (!sawOutput && data.length > 0) {
        sawOutput = true
        if (fallbackTimer !== null && !startupShellReady && lastPtyId) {
          clearFallbackTimer()
          armFallback(lastPtyId)
        }
      }
      if (!markerScan) {
        return data
      }
      const scanned = scanForShellReadyMarker(markerScan, data)
      if (scanned.matched) {
        markShellReady()
      }
      return scanned.output
    },
    armFallback,
    schedule,
    clear() {
      clearInjectTimer()
      clearFallbackTimer()
      pendingCommand = null
      lastPtyId = null
    }
  }
}
