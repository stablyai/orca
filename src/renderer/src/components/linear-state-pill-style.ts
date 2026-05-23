import type { CSSProperties } from 'react'

type LinearStatePillStyle = CSSProperties & {
  '--linear-state-pill-background': string
  '--linear-state-pill-border': string
  '--linear-state-pill-foreground': string
  '--linear-state-pill-hover-background': string
  '--linear-state-pill-hover-border': string
  '--linear-state-pill-hover-foreground': string
}

// Why: Linear workspace colors can be very light in light mode. Mixing the
// visible parts toward foreground preserves hue while keeping labels readable.
export function getLinearStatePillStyle(color: string): LinearStatePillStyle {
  return {
    '--linear-state-pill-background': `color-mix(in srgb, ${color} 12%, transparent)`,
    '--linear-state-pill-border': `color-mix(in srgb, ${color} 24%, var(--border))`,
    '--linear-state-pill-foreground': `color-mix(in srgb, ${color} 28%, var(--foreground))`,
    '--linear-state-pill-hover-background': `color-mix(in srgb, ${color} 18%, transparent)`,
    '--linear-state-pill-hover-border': `color-mix(in srgb, ${color} 32%, var(--border))`,
    '--linear-state-pill-hover-foreground': `color-mix(in srgb, ${color} 28%, var(--foreground))`,
    borderColor: 'var(--linear-state-pill-current-border, var(--linear-state-pill-border))',
    backgroundColor:
      'var(--linear-state-pill-current-background, var(--linear-state-pill-background))',
    color: 'var(--linear-state-pill-current-foreground, var(--linear-state-pill-foreground))'
  }
}

export function getLinearStateMarkerStyle(color: string): CSSProperties {
  return {
    backgroundColor: `color-mix(in srgb, ${color} 42%, var(--foreground))`
  }
}
