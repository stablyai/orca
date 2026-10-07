const WINDOW_GLASS_ARGUMENT = '--orca-window-glass'

export const DEFAULT_NATIVE_CHAT_GLASS_OPACITY = 0.6
export const DEFAULT_INTERFACE_GLASS_OPACITY = 0.75
export const MIN_GLASS_OPACITY = 0.2

/** Whether the window is created with a see-through backdrop; it applies at creation, so the renderer reads it from argv rather than live settings. */
export function shouldCreateGlassWindow(
  platform: NodeJS.Platform,
  windowBackgroundBlur: boolean
): boolean {
  return windowBackgroundBlur && platform === 'darwin'
}

export function formatWindowGlassArgument(): string {
  return WINDOW_GLASS_ARGUMENT
}

export function hasWindowGlassArgument(argv: readonly string[]): boolean {
  return argv.includes(WINDOW_GLASS_ARGUMENT)
}

function normalizeGlassOpacity(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(1, Math.max(MIN_GLASS_OPACITY, value))
}

export function normalizeNativeChatGlassOpacity(value: unknown): number {
  return normalizeGlassOpacity(value, DEFAULT_NATIVE_CHAT_GLASS_OPACITY)
}

export function normalizeInterfaceGlassOpacity(value: unknown): number {
  return normalizeGlassOpacity(value, DEFAULT_INTERFACE_GLASS_OPACITY)
}
