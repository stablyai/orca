export const WINDOW_CONTROLS_POSITIONS = ['left', 'right'] as const

export type WindowControlsPosition = (typeof WINDOW_CONTROLS_POSITIONS)[number]

export const DEFAULT_WINDOW_CONTROLS_POSITION: WindowControlsPosition = 'right'

export function normalizeWindowControlsPosition(value: unknown): WindowControlsPosition {
  return value === 'left' || value === 'right' ? value : DEFAULT_WINDOW_CONTROLS_POSITION
}

/** Linux custom chrome can flip sides; Windows stays right; macOS uses native traffic lights. */
export function resolveWindowControlsSide(input: {
  platform: NodeJS.Platform
  preference: WindowControlsPosition | undefined
}): WindowControlsPosition {
  if (input.platform !== 'linux') {
    return 'right'
  }
  return normalizeWindowControlsPosition(input.preference)
}
