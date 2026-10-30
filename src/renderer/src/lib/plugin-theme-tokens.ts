/** sRGB channels 0-255 and alpha 0-1, or null when the value is not a CSS color. */
export type ColorProbe = (value: string) => readonly [number, number, number, number] | null
export type Rgba = readonly [number, number, number, number]

// Why: a theme must not be able to hide text, so every text/surface pair keeps WCAG AA contrast.
const CONTRAST_PAIRS: readonly (readonly [string, string])[] = [
  ['--background', '--foreground'],
  ['--background', '--muted-foreground'],
  // Notebook markdown renders directly on the editor surface.
  ['--editor-surface', '--foreground'],
  ['--editor-surface', '--muted-foreground'],
  ['--card', '--card-foreground'],
  ['--popover', '--popover-foreground'],
  ['--primary', '--primary-foreground'],
  ['--secondary', '--secondary-foreground'],
  ['--muted', '--muted-foreground'],
  ['--accent', '--accent-foreground'],
  ['--sidebar', '--sidebar-foreground'],
  ['--sidebar-primary', '--sidebar-primary-foreground'],
  ['--sidebar-accent', '--sidebar-accent-foreground'],
  ['--worktree-sidebar', '--worktree-sidebar-foreground'],
  ['--worktree-sidebar-accent', '--worktree-sidebar-accent-foreground']
]
const MIN_TEXT_CONTRAST = 4.5
// Why 2:1, not WCAG's 3:1: Orca's own light ring is 2.6:1; the goal is a ring that never vanishes.
const RINGS: readonly (readonly [string, string])[] = [
  ['--ring', '--background'],
  ['--sidebar-ring', '--sidebar'],
  ['--worktree-sidebar-ring', '--worktree-sidebar']
]
const MIN_RING_CONTRAST = 2
// Why a floor, not opaque: Orca's own dark borders are 7% white; 0 or near-0 alpha hides them.
const BORDERS = ['--border', '--input', '--sidebar-border', '--worktree-sidebar-border']
const MIN_BORDER_ALPHA = 0.05

function luminance([r, g, b]: Rgba): number {
  const channel = (value: number): number => {
    const c = value / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/** WCAG contrast ratio between two opaque colors. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const first = luminance(a)
  const second = luminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

/**
 * The plugin tokens that are safe to paint over the built-in ones for the theme's base.
 * Checks run on the effective set (plugin values, else built-in), and dropping a token can
 * expose a built-in value that breaks another pair, so checks repeat until nothing changes.
 * Dropped tokens keep their built-in values.
 */
export function safePluginThemeTokens(
  tokens: Readonly<Record<string, string>>,
  builtIns: Readonly<Record<string, string>>,
  probe: ColorProbe
): Record<string, string> {
  const accepted = new Map<string, Rgba>()
  for (const [token, value] of Object.entries(tokens)) {
    const color = probe(value)
    if (color && !(BORDERS.includes(token) && color[3] < MIN_BORDER_ALPHA)) {
      accepted.set(token, color)
    }
  }
  const builtInColors = new Map<string, Rgba | null>()
  const effective = (token: string): Rgba | null => {
    const own = accepted.get(token)
    if (own) {
      return own
    }
    if (!builtInColors.has(token)) {
      builtInColors.set(token, builtIns[token] ? probe(builtIns[token]) : null)
    }
    return builtInColors.get(token) ?? null
  }
  const drop = (...pair: string[]): boolean =>
    pair.map((token) => accepted.delete(token)).some(Boolean)

  for (let changed = true; changed;) {
    changed = false
    for (const [surface, text] of CONTRAST_PAIRS) {
      const surfaceColor = effective(surface)
      const textColor = effective(text)
      if (
        surfaceColor &&
        textColor &&
        (surfaceColor[3] < 1 ||
          textColor[3] < 1 ||
          contrastRatio(surfaceColor, textColor) < MIN_TEXT_CONTRAST)
      ) {
        changed = drop(surface, text) || changed
      }
    }
    for (const [ring, surface] of RINGS) {
      const ringColor = accepted.get(ring)
      const surfaceColor = effective(surface)
      if (
        ringColor &&
        surfaceColor &&
        contrastRatio(over(ringColor, surfaceColor), surfaceColor) < MIN_RING_CONTRAST
      ) {
        changed = drop(ring) || changed
      }
    }
  }
  return Object.fromEntries(Object.entries(tokens).filter(([token]) => accepted.has(token)))
}

let probeContext: OffscreenCanvasRenderingContext2D | null | undefined

/** Resolves a color through the browser's own parser by painting one pixel. */
export const browserColorProbe: ColorProbe = (value) => {
  if (typeof CSS === 'undefined' || !CSS.supports('color', value)) {
    return null
  }
  probeContext ??=
    typeof OffscreenCanvas === 'undefined'
      ? null
      : new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true })
  if (!probeContext) {
    return null
  }
  const context = probeContext
  // Why two seeds: fillStyle silently keeps its old value for values it rejects (e.g. `inherit`).
  const paint = (seed: string): number[] => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = seed
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data]
  }
  const first = paint('#000000')
  const second = paint('#ffffff')
  if (first.some((channel, index) => channel !== second[index])) {
    return null
  }
  const [r = 0, g = 0, b = 0, a = 0] = first
  return [r, g, b, a / 255]
}
