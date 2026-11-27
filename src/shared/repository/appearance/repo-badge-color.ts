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

function hexChannels(hex: string): number[] {
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
}

const toHex = (channels: number[]): string =>
  `#${channels.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`

// Soft tint: a translucent wash of the color with letters in a deeper (light theme) or brighter
// (dark theme) shade of the same hue, so the mark keeps one hue instead of white/black text.
const SOFT_FILL_ALPHA = 0.2
const SOFT_TEXT_SHIFT = 0.6

export type SoftMarkColors = { background: string; foreground: string }

// Why: small monogram letters (~9px in an 18px badge) need high contrast against the actual composited wash.
const MIN_SOFT_TEXT_CONTRAST = 6
// Worst-case card surfaces marks sit on: --worktree-sidebar-accent (#353535 dark, #eaeaea light).
const SOFT_SURFACE = { dark: [53, 53, 53], light: [234, 234, 234] }

function compositeOver(fg: number[], bg: number[], alpha: number): number[] {
  return fg.map((value, index) => Math.round(value * alpha + bg[index] * (1 - alpha)))
}

function channelsLuminance(channels: number[]): number {
  const [r, g, b] = channels.map((value) => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: number[], b: number[]): number {
  const [light, dark] = [channelsLuminance(a), channelsLuminance(b)].sort((x, y) => y - x)
  return (light + 0.05) / (dark + 0.05)
}

export function softMarkColors(color: unknown, scheme: 'light' | 'dark'): SoftMarkColors {
  const channels = hexChannels(resolveRepoBadgeColor(color))
  const target = scheme === 'dark' ? 255 : 0
  const shiftBy = (amount: number): number[] =>
    channels.map((value) => Math.round(value + (target - value) * amount))
  // Near-black washes vanish on dark surfaces (and near-white on light); lift only those washes.
  const baseLuminance = channelsLuminance(channels)
  const washBlendsIntoSurface =
    (scheme === 'dark' && baseLuminance < 0.06) || (scheme === 'light' && baseLuminance > 0.85)
  const wash = washBlendsIntoSurface ? shiftBy(SOFT_TEXT_SHIFT) : channels
  const compositedBackground = compositeOver(wash, SOFT_SURFACE[scheme], SOFT_FILL_ALPHA)
  let shift = SOFT_TEXT_SHIFT
  while (
    shift < 1 &&
    contrastRatio(shiftBy(shift), compositedBackground) < MIN_SOFT_TEXT_CONTRAST
  ) {
    shift = Math.min(1, shift + 0.05)
  }
  const foreground = shiftBy(shift)
  return {
    background: `rgba(${wash.join(', ')}, ${SOFT_FILL_ALPHA})`,
    foreground: toHex(foreground)
  }
}
