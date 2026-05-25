import type { GlobalSettings } from './types'

/**
 * Why: glass effect is gated by both the user setting AND the host
 * platform — Electron vibrancy + transparent windows are macOS-only.
 * Centralizing the check keeps call sites short and ensures non-macOS
 * hosts never try to render glass surfaces (which would just look like
 * a broken low-alpha UI without the OS-level vibrancy backdrop).
 *
 * Pass `isDarwin` explicitly when running outside the renderer so the
 * check stays pure (the renderer's default uses navigator.userAgent).
 */
export function isGlassEffectActive(
  settings: Pick<GlobalSettings, 'glassEffect'> | null | undefined,
  options?: { isDarwin?: boolean }
): boolean {
  if (!settings?.glassEffect) {
    return false
  }
  const isDarwin =
    options?.isDarwin ??
    (typeof process !== 'undefined'
      ? process.platform === 'darwin'
      : typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac'))
  return isDarwin
}
