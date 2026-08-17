/**
 * Detached panes are same-renderer auxiliary windows: the main renderer opens an
 * `about:blank` child and portals a tab group into it. Main matches this frame
 * name to allow the open (privileged-window-navigation.ts) — every other
 * `window.open` from an Orca window is still denied.
 */
const AUX_WINDOW_FRAME_NAME_PREFIX = 'orca-aux-pane:'
const AUX_WINDOW_GROUP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

export function auxWindowFrameName(groupId: string): string {
  if (!AUX_WINDOW_GROUP_ID_PATTERN.test(groupId)) {
    throw new Error('Invalid detached pane group id')
  }
  return `${AUX_WINDOW_FRAME_NAME_PREFIX}${groupId}`
}

export function isAuxWindowFrameName(frameName: string): boolean {
  return (
    frameName.startsWith(AUX_WINDOW_FRAME_NAME_PREFIX) &&
    AUX_WINDOW_GROUP_ID_PATTERN.test(frameName.slice(AUX_WINDOW_FRAME_NAME_PREFIX.length))
  )
}

/** Screen position and size of a detached pane's window, persisted per group. */
export type AuxWindowBounds = {
  x: number
  y: number
  width: number
  height: number
}

export const AUX_WINDOW_DEFAULT_SIZE = { width: 900, height: 600 } as const

/**
 * `window.open` features string. Bounds travel this way because the renderer
 * cannot construct a BrowserWindow directly — main parses them back out in
 * `privileged-window-navigation.ts`.
 */
export function auxWindowFeatures(bounds: AuxWindowBounds | null): string {
  const size = bounds ?? {
    ...AUX_WINDOW_DEFAULT_SIZE,
    x: Number.NaN,
    y: Number.NaN
  }
  const parts = [`width=${Math.round(size.width)}`, `height=${Math.round(size.height)}`]
  if (Number.isFinite(size.x) && Number.isFinite(size.y)) {
    parts.push(`left=${Math.round(size.x)}`, `top=${Math.round(size.y)}`)
  }
  return parts.join(',')
}

/** Parse the features string produced by `auxWindowFeatures`. */
export function parseAuxWindowFeatures(features: string): Partial<AuxWindowBounds> {
  const parsed: Partial<AuxWindowBounds> = {}
  for (const entry of features.split(',')) {
    const [rawKey, rawValue] = entry.split('=')
    const value = Number.parseInt(rawValue ?? '', 10)
    if (!Number.isFinite(value)) {
      continue
    }
    switch (rawKey?.trim()) {
      case 'width':
        parsed.width = value
        break
      case 'height':
        parsed.height = value
        break
      case 'left':
        parsed.x = value
        break
      case 'top':
        parsed.y = value
        break
    }
  }
  return parsed
}
