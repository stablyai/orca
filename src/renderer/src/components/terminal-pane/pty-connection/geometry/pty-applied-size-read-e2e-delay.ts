import { e2eConfig } from '@/lib/e2e-config'

// exposeStore-only seam delays size readback behind reveal resize, reproducing busy-host/SSH ordering deterministically.
export function getAppliedSizeReadE2eDelayMs(): number {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return 0
  }
  const delayMs = window.__e2ePtyAppliedSizeReadDelayMs
  return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
}
