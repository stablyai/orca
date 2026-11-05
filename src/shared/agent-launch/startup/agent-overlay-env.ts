// Why: a nested terminal can inherit prior OpenCode/Pi/OMP overlay env; restore the user's recorded source dir, else strip only Orca-owned values.
export function restoreOrStripOverlayEnv(
  baseEnv: Record<string, string>,
  keys: {
    primary: string
    overlay: string
    source: string
    preserveExplicitPrimary?: boolean
  },
  inheritedEnv: NodeJS.ProcessEnv = process.env
): void {
  const sourceValue = baseEnv[keys.source] ?? inheritedEnv[keys.source]
  const overlayValue = baseEnv[keys.overlay] ?? inheritedEnv[keys.overlay]
  // Source-only markers from older launches still identify an inherited overlay.
  const preservePrimary =
    keys.preserveExplicitPrimary &&
    Boolean(overlayValue) &&
    baseEnv[keys.primary] !== undefined &&
    baseEnv[keys.primary] !== overlayValue
  if (sourceValue && !preservePrimary) {
    baseEnv[keys.primary] = sourceValue
  } else if (overlayValue && baseEnv[keys.primary] === overlayValue) {
    delete baseEnv[keys.primary]
  }
  delete baseEnv[keys.overlay]
  delete baseEnv[keys.source]
}
