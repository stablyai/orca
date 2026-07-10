import { HEX_COLOR_RE } from './color-validation'
import type { LeftSidebarAppearanceMode } from './types'

export const LEFT_SIDEBAR_APPEARANCE_MODES = ['default', 'match-terminal', 'tinted'] as const

export const DEFAULT_LEFT_SIDEBAR_TINT_COLOR = '#18181b'
export const DEFAULT_LEFT_SIDEBAR_TINT_OPACITY = 0.08
export const MAX_LEFT_SIDEBAR_TINT_OPACITY = 0.35

export function normalizeLeftSidebarAppearanceMode(value: unknown): LeftSidebarAppearanceMode {
  return LEFT_SIDEBAR_APPEARANCE_MODES.includes(value as LeftSidebarAppearanceMode)
    ? (value as LeftSidebarAppearanceMode)
    : 'default'
}

export function normalizeLeftSidebarTintColor(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_LEFT_SIDEBAR_TINT_COLOR
  }
  const trimmed = value.trim()
  if (!trimmed || !HEX_COLOR_RE.test(trimmed)) {
    return DEFAULT_LEFT_SIDEBAR_TINT_COLOR
  }
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`
}

export function normalizeLeftSidebarTintOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LEFT_SIDEBAR_TINT_OPACITY
  }
  return Math.min(MAX_LEFT_SIDEBAR_TINT_OPACITY, Math.max(0, value))
}
