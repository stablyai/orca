import {
  pluginAppThemeCssFallback,
  type PluginThemeCssFallbackRule
} from '../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'

/** sRGB channels 0-255 and alpha 0-1, or null when the value is not a CSS color. */
export type ColorProbe = (value: string) => readonly [number, number, number, number] | null
export type Rgba = readonly [number, number, number, number]

type ContrastRule = {
  surface: string
  text: string
  min: number
  /** What a failure drops, when not both sides: never a shared token this check must not cost. */
  drop?: readonly string[]
  /** A translucent surface is checked as painted over this opaque one. */
  over?: string
  /** Also dropped when the theme omitted the surface, which then follows this token. */
  surfaceSource?: string
}

const MIN_TEXT_CONTRAST = 4.5
// Why 3:1: status hues tint file names, and Orca's own light ignored color is 3.3:1.
const MIN_STATUS_TEXT_CONTRAST = 3
const textPair = (surface: string, text: string): ContrastRule => ({
  surface,
  text,
  min: MIN_TEXT_CONTRAST
})
const GIT_DECORATIONS = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'untracked',
  'copied',
  'ignored'
]

// Why: a theme must not be able to hide text, so every text/surface pair keeps WCAG AA contrast.
const CONTRAST_RULE_DEFINITIONS: readonly ContrastRule[] = [
  textPair('--background', '--foreground'),
  textPair('--background', '--muted-foreground'),
  // Notebook markdown renders directly on the editor surface.
  textPair('--editor-surface', '--foreground'),
  textPair('--editor-surface', '--muted-foreground'),
  textPair('--card', '--card-foreground'),
  textPair('--popover', '--popover-foreground'),
  textPair('--primary', '--primary-foreground'),
  textPair('--secondary', '--secondary-foreground'),
  textPair('--muted', '--muted-foreground'),
  textPair('--accent', '--accent-foreground'),
  textPair('--sidebar', '--sidebar-foreground'),
  textPair('--sidebar-primary', '--sidebar-primary-foreground'),
  textPair('--sidebar-accent', '--sidebar-accent-foreground'),
  textPair('--worktree-sidebar', '--worktree-sidebar-foreground'),
  textPair('--worktree-sidebar-accent', '--worktree-sidebar-accent-foreground'),
  {
    ...textPair('--worktree-sidebar-active', '--worktree-sidebar-foreground'),
    drop: ['--worktree-sidebar-active'],
    over: '--worktree-sidebar'
  },
  { ...textPair('--host-badge', '--host-badge-foreground'), over: '--worktree-sidebar' },
  textPair('--tab-active', '--tab-active-foreground'),
  textPair('--tab-inactive', '--tab-inactive-foreground'),
  // Hovered inactive tabs take the active text color.
  textPair('--tab-inactive', '--tab-active-foreground'),
  {
    ...textPair('--chat-user-message', '--chat-foreground-strong'),
    drop: ['--chat-user-message'],
    over: '--chat-canvas'
  },
  ...['added', 'removed'].flatMap((side): ContrastRule[] => {
    const tint = (kind: string): ContrastRule => ({
      ...textPair(`--diff-${side}-${kind}`, '--foreground'),
      drop: [`--diff-${side}-${kind}`],
      surfaceSource: `--diff-${side}`,
      over: '--editor-surface'
    })
    // Chat diff rows paint the hue-mixed text on the line tint over the chat canvas.
    return [
      tint('background'),
      tint('emphasis'),
      { ...tint('background'), text: `--chat-diff-${side}`, over: '--chat-canvas' }
    ]
  }),
  { ...textPair('--editor-surface', '--text-link'), drop: ['--text-link'] },
  ...GIT_DECORATIONS.map((status): ContrastRule => ({
    surface: '--sidebar',
    text: `--git-decoration-${status}`,
    min: MIN_STATUS_TEXT_CONTRAST,
    drop: [`--git-decoration-${status}`]
  }))
]
const CONTRAST_RULES = CONTRAST_RULE_DEFINITIONS.map((rule) => ({
  ...rule,
  dropped: rule.drop ?? [rule.surface, rule.text]
}))
// Why 2:1, not WCAG's 3:1: Orca's own light ring is 2.6:1; the goal is a ring that never vanishes.
const RINGS: readonly (readonly [string, string])[] = [
  ['--ring', '--background'],
  ['--sidebar-ring', '--sidebar'],
  ['--worktree-sidebar-ring', '--worktree-sidebar'],
  ['--tab-active-indicator', '--tab-active']
]
const MIN_RING_CONTRAST = 2
// Why a floor, not opaque: Orca's own dark borders are 7% white; 0 or near-0 alpha hides them.
const BORDERS = [
  '--border',
  '--input',
  '--sidebar-border',
  '--worktree-sidebar-border',
  '--worktree-sidebar-active-border',
  '--split-divider',
  '--split-divider-hover'
]
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

export function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

/** `color-mix(in srgb, a percent%, b)`. */
function mix(a: Rgba, b: Rgba, percent: number): Rgba {
  const p = percent / 100
  const channel = (index: 0 | 1 | 2 | 3): number => a[index] * p + b[index] * (1 - p)
  return [channel(0), channel(1), channel(2), channel(3)]
}

/**
 * The plugin tokens that are safe to paint over the built-in ones for the theme's base.
 * Checks run on the effective set (plugin values, else what main.css derives from them, else
 * built-in), and dropping a token can expose a value that breaks another pair, so checks repeat
 * until nothing changes. Dropped tokens keep their built-in values.
 */
export function safePluginThemeTokens(
  tokens: Readonly<Record<string, string>>,
  base: 'light' | 'dark',
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
  const derived = (rule: PluginThemeCssFallbackRule): Rgba | null => {
    if ('tint' in rule) {
      const hue = effective(rule.tint)
      return hue ? [hue[0], hue[1], hue[2], (hue[3] * rule.percent) / 100] : null
    }
    if (!('mixForeground' in rule)) {
      return rule.map(effective).find(Boolean) ?? null
    }
    const foreground = effective('--foreground')
    const into = effective(rule.into ?? '--background')
    return foreground && into ? mix(foreground, into, rule.mixForeground) : null
  }
  function effective(token: string): Rgba | null {
    const own = accepted.get(token)
    if (own) {
      return own
    }
    const fallback = pluginAppThemeCssFallback(token, base)
    if (fallback) {
      return derived(fallback)
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
    for (const rule of CONTRAST_RULES) {
      const dropped =
        rule.surfaceSource && tokens[rule.surface] === undefined
          ? [...rule.dropped, rule.surfaceSource]
          : rule.dropped
      // Why skip: a check with nothing of the theme's to drop can't change the result, so a
      // theme that sets none of a check's tokens pays no probes for it.
      if (!dropped.some((token) => accepted.has(token))) {
        continue
      }
      const textColor = effective(rule.text)
      const ownSurface = effective(rule.surface)
      const beneath = rule.over ? effective(rule.over) : null
      const surfaceColor = ownSurface && beneath?.[3] === 1 ? over(ownSurface, beneath) : ownSurface
      if (
        surfaceColor &&
        textColor &&
        (surfaceColor[3] < 1 ||
          textColor[3] < 1 ||
          contrastRatio(surfaceColor, textColor) < rule.min)
      ) {
        changed = drop(...dropped) || changed
      }
    }
    for (const [ring, surface] of RINGS) {
      const ringColor = accepted.get(ring)
      if (!ringColor) {
        continue
      }
      const surfaceColor = effective(surface)
      if (
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
