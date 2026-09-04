import { DEFAULT_REPO_BADGE_COLOR } from './constants'
import { normalizeHexColor } from './hex-color'

export function normalizeRepoBadgeColor(value: unknown): string | null {
  return normalizeHexColor(value)
}

export function resolveRepoBadgeColor(value: unknown): string {
  return normalizeRepoBadgeColor(value) ?? DEFAULT_REPO_BADGE_COLOR
}
