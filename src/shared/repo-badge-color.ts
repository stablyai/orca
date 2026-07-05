import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from './constants'

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

// Round-robin over the non-default palette colors so each new project gets a
// visually distinct badge. Index 0 is the neutral "uncolored" gray default, so
// it is excluded; cycling is by how many projects already exist.
export function pickRoundRobinRepoBadgeColor(existingProjectCount: number): string {
  const palette = REPO_COLORS.slice(1) // exclude neutral gray default
  const index = ((existingProjectCount % palette.length) + palette.length) % palette.length
  return palette[index]
}
