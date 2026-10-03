const WINDOW_GLASS_ARGUMENT = '--orca-window-glass'

export const DEFAULT_NATIVE_CHAT_GLASS_OPACITY = 0.6
export const MIN_NATIVE_CHAT_GLASS_OPACITY = 0.2

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

export function normalizeNativeChatGlassOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_NATIVE_CHAT_GLASS_OPACITY
  }
  return Math.min(1, Math.max(MIN_NATIVE_CHAT_GLASS_OPACITY, value))
}
