import { e2eConfig } from '@/lib/e2e-config'

// Why: e2e seam for the stale-reveal-resize regression spec. The visibility
// resume readback (pty-size-reassertion) is only safe when the applied-size
// read is processed before the reveal fit's PTY resize; a busy daemon or
// SSH/relay round-trip breaks that ordering in the field. The spec sets this
// window global to reproduce the losing ordering deterministically. Gated on
// exposeStore so packaged builds ignore it.
export function getAppliedSizeReadE2eDelayMs(): number {
  if (!e2eConfig.exposeStore || typeof window === 'undefined') {
    return 0
  }
  const delayMs = window.__e2ePtyAppliedSizeReadDelayMs
  return typeof delayMs === 'number' && Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0
}
