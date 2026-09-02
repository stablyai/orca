import { HEX_COLOR_RE } from './color-validation'

export const DEFAULT_SIDEBAR_TINT_COLOR = '#18181b'
export const DEFAULT_SIDEBAR_TINT_OPACITY = 0.08
export const MAX_SIDEBAR_TINT_OPACITY = 0.35

export function normalizeSidebarTintColor(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_SIDEBAR_TINT_COLOR
  }
  const trimmed = value.trim()
  if (!trimmed || !HEX_COLOR_RE.test(trimmed)) {
    return DEFAULT_SIDEBAR_TINT_COLOR
  }
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

export function normalizeSidebarTintOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SIDEBAR_TINT_OPACITY
  }
  return Math.min(MAX_SIDEBAR_TINT_OPACITY, Math.max(0, value))
}
