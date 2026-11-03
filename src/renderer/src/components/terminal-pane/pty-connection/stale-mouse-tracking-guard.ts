import { isShellProcess } from '../../../../../shared/shell-process-detection'

// Bounds the process-table reads a hovering mouse can trigger.
const PROBE_COOLDOWN_MS = 2_000

type ForegroundRead = {
  processName: string | null
  remoteEvidenceVerdict: 'live' | 'unverifiable' | 'exited' | null
}

/**
 * A program killed under a shell that sends no OSC 133 leaves mouse tracking armed, so every
 * pointer move types a report into the prompt. The first report after death asks who owns the
 * foreground and grounds the modes once it is a shell.
 */
export function createStaleMouseTrackingGuard(deps: {
  getPtyId: () => string | null
  isTrackablePtyId: (ptyId: string) => boolean
  isMouseTrackingArmed: () => boolean
  readConfirmedForeground: (ptyId: string) => Promise<ForegroundRead>
  groundToShell: () => void
  now?: () => number
}): { observeMouseReport: () => void } {
  const now = deps.now ?? Date.now
  let probing = false
  let lastProbeAt = Number.NEGATIVE_INFINITY

  return {
    observeMouseReport() {
      const ptyId = deps.getPtyId()
      if (probing || !ptyId || !deps.isMouseTrackingArmed() || !deps.isTrackablePtyId(ptyId)) {
        return
      }
      const startedAt = now()
      if (startedAt - lastProbeAt < PROBE_COOLDOWN_MS) {
        return
      }
      lastProbeAt = startedAt
      probing = true
      void deps
        .readConfirmedForeground(ptyId)
        .then(({ processName, remoteEvidenceVerdict }) => {
          // A rebound PTY or an already-reset terminal needs no ground.
          if (deps.getPtyId() !== ptyId || !deps.isMouseTrackingArmed()) {
            return
          }
          if (remoteEvidenceVerdict !== null && remoteEvidenceVerdict !== 'live') {
            return
          }
          if (processName !== null && isShellProcess(processName)) {
            deps.groundToShell()
          }
        })
        .catch(() => {})
        .finally(() => {
          probing = false
        })
    }
  }
}
