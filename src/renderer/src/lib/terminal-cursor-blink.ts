/**
 * Resolve whether the terminal cursor should blink.
 *
 * Why (#10481): Chromium's caret/cursor blink invalidates large ancestor paint
 * regions when not isolated. Prefer no blink under reduced-motion, matching the
 * OS accessibility preference that already kills the idle ~40% core cost.
 */
export function resolveTerminalCursorBlink(args: {
  settingEnabled?: boolean
  prefersReducedMotion?: boolean
}): boolean {
  if (args.prefersReducedMotion === true) {
    return false
  }
  // Default on when the setting is unset (matches buildDefaultTerminalOptions).
  return args.settingEnabled !== false
}

export function readPrefersReducedMotion(
  matchMedia: ((query: string) => MediaQueryList) | undefined = globalThis.matchMedia?.bind(
    globalThis
  )
): boolean {
  if (typeof matchMedia !== 'function') {
    return false
  }
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}
