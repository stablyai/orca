export const REPO_COLORS = [
  '#737373', // neutral
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#8b5cf6', // purple
  '#ec4899' // pink
] as const

export const DEFAULT_REPO_BADGE_COLOR = REPO_COLORS[0]

const HEX_COLOR_PATTERN = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function normalizeRepoBadgeColor(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  const match = value.trim().match(HEX_COLOR_PATTERN)
  if (!match) {
    return null
  }

  const rawHex = match[1].toLowerCase()
  const hex =
    rawHex.length === 3
      ? rawHex
          .split('')
          .map((part) => part + part)
          .join('')
      : rawHex
  const normalized = `#${hex}`
  return REPO_COLORS.find((repoColor) => repoColor === normalized) ?? normalized
}

export function resolveRepoBadgeColor(value: unknown): string {
  return normalizeRepoBadgeColor(value) ?? DEFAULT_REPO_BADGE_COLOR
}
