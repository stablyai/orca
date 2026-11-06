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
  getBinding: () => { ptyId: string; incarnationId: string | null } | null
  isTrackablePtyId: (ptyId: string) => boolean
  isMouseTrackingArmed: () => boolean
  readConfirmedForeground: (ptyId: string) => Promise<ForegroundRead>
  groundToShell: () => void
  now?: () => number
}): { observeUserInput: (isMouseReport: boolean) => void } {
  const now = deps.now ?? Date.now
  const bindingKey = (): string | null => {
    const binding = deps.getBinding()
    return binding ? `${binding.ptyId}#${binding.incarnationId ?? ''}` : null
  }
  let probe: { key: string; inputGeneration: number } | null = null
  let lastProbe = { key: '', at: Number.NEGATIVE_INFINITY }
  // Typed input may launch a program, so a verdict read before it is stale.
  let inputGeneration = 0

  return {
    observeUserInput(isMouseReport) {
      if (!isMouseReport) {
        inputGeneration += 1
        return
      }
      const binding = deps.getBinding()
      const key = bindingKey()
      if (!binding || key === null || !deps.isMouseTrackingArmed()) {
        return
      }
      if (!deps.isTrackablePtyId(binding.ptyId) || probe?.key === key) {
        return
      }
      const startedAt = now()
      if (lastProbe.key === key && startedAt - lastProbe.at < PROBE_COOLDOWN_MS) {
        return
      }
      lastProbe = { key, at: startedAt }
      const thisProbe = { key, inputGeneration }
      probe = thisProbe
      void deps
        .readConfirmedForeground(binding.ptyId)
        .then(({ processName, remoteEvidenceVerdict }) => {
          // A rebound PTY, newer input or an already-reset terminal needs no ground.
          if (
            bindingKey() !== key ||
            inputGeneration !== thisProbe.inputGeneration ||
            !deps.isMouseTrackingArmed()
          ) {
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
          if (probe === thisProbe) {
            probe = null
          }
        })
    }
  }
}
