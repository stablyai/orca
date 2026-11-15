import { contrastRatio, type Rgba } from '../color/rgba-contrast'
import { rgbaToOklch } from '../color/oklch-color-transform'
import { cssColorProbe } from '../theme/css-color-probe'
import { CSS_COLOR_SPACES } from '../theme/css-color-spaces'
import type { ThemeStudioDraft, ThemeStudioMode, ThemeStudioVariant } from './theme-studio-draft'

/** Advice that never stops a color from painting, unlike the contrast gate's findings. */
export type ThemeStudioWarning = {
  /** Stable for the same rule, mode and tokens across revisions. */
  id: string
  rule: 'ansi-floor' | 'ansi-hue' | 'surface-seam' | 'diff-hue' | 'pair-hue'
  mode?: ThemeStudioMode
  tokens: string[]
  message: string
}

const ANSI_HUES = {
  red: 29,
  green: 142,
  yellow: 100,
  blue: 264,
  magenta: 328,
  cyan: 195
} as const
type AnsiHue = keyof typeof ANSI_HUES
const ANSI_KEYS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const
type AnsiKey = (typeof ANSI_KEYS)[number]

// Why 3:1: terminal output is text, and below the large-text floor colored output stops reading.
const ANSI_MIN_CONTRAST = 3
const HUE_TOLERANCE = 50
// Why: below this OKLCH chroma a color reads as grey, so its hue says nothing.
const MIN_CHROMA = 0.05
// Why: OKLab distance; under 0.005 two surfaces read as one, past 0.03 as deliberately different.
const SEAM_MIN = 0.005
const SEAM_MAX = 0.03
// Tokens whose hue a light/dark pair should share: the theme's accent and identity colors.
const PAIRED_TOKENS = [
  '--primary',
  '--ring',
  '--text-link',
  '--sidebar-primary',
  '--worktree-sidebar',
  '--diff-added',
  '--diff-removed',
  '--git-decoration-modified'
]

const opaque = (value: string | undefined): Rgba | null => {
  const color = value === undefined ? null : cssColorProbe(value)
  return color && color[3] === 1 ? color : null
}

const hueDistance = (a: number, b: number): number => {
  const diff = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(diff, 360 - diff)
}

const isAnsiHue = (name: string): name is AnsiHue => Object.hasOwn(ANSI_HUES, name)

const baseHueOf = (key: AnsiKey): AnsiHue | null => {
  const base = key.replace(/^bright/, '').toLowerCase()
  return isAnsiHue(base) ? base : null
}

function oklabDistance(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = CSS_COLOR_SPACES.oklab.to([a[0] / 255, a[1] / 255, a[2] / 255])
  const [l2, a2, b2] = CSS_COLOR_SPACES.oklab.to([b[0] / 255, b[1] / 255, b[2] / 255])
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2)
}

function terminalWarnings(
  mode: ThemeStudioMode,
  variant: ThemeStudioVariant
): ThemeStudioWarning[] {
  const terminal = variant.terminal ?? {}
  const background = opaque(terminal.background)
  const warnings: ThemeStudioWarning[] = []
  if (!background) {
    return warnings
  }
  for (const key of ANSI_KEYS) {
    const color = opaque(terminal[key])
    if (!color) {
      continue
    }
    // Why skip: black on a dark terminal and white on a light one are dim by design.
    const designedDim =
      (mode === 'dark' && (key === 'black' || key === 'brightBlack')) ||
      (mode === 'light' && (key === 'white' || key === 'brightWhite'))
    const ratio = contrastRatio(color, background)
    if (!designedDim && ratio < ANSI_MIN_CONTRAST) {
      warnings.push({
        id: `${mode}-ansi-floor-${key}`,
        rule: 'ansi-floor',
        mode,
        tokens: [`terminal.${key}`],
        message: `terminal.${key} is ${ratio.toFixed(2)}:1 on the terminal background; colored output needs ${ANSI_MIN_CONTRAST}:1 to read.`
      })
    }
    const base = baseHueOf(key)
    const { c, h } = rgbaToOklch(color)
    if (base && c >= MIN_CHROMA && hueDistance(h, ANSI_HUES[base]) > HUE_TOLERANCE) {
      warnings.push({
        id: `${mode}-ansi-hue-${key}`,
        rule: 'ansi-hue',
        mode,
        tokens: [`terminal.${key}`],
        message: `terminal.${key} no longer reads as ${base} (hue ${Math.round(h)}°); tools use it to mean ${base === 'red' ? 'errors' : base === 'green' ? 'success' : base === 'yellow' ? 'warnings' : base}.`
      })
    } else if (base && c < MIN_CHROMA / 2) {
      warnings.push({
        id: `${mode}-ansi-hue-${key}`,
        rule: 'ansi-hue',
        mode,
        tokens: [`terminal.${key}`],
        message: `terminal.${key} is nearly grey, so ${base} output looks like plain text.`
      })
    }
  }
  const surfaceToken =
    variant.tokens['--editor-surface'] !== undefined ? '--editor-surface' : '--background'
  const surface = opaque(variant.tokens[surfaceToken])
  const distance = surface ? oklabDistance(surface, background) : 0
  if (surface && distance > SEAM_MIN && distance < SEAM_MAX) {
    warnings.push({
      id: `${mode}-surface-seam`,
      rule: 'surface-seam',
      mode,
      tokens: ['terminal.background', surfaceToken],
      message: `The terminal and editor backgrounds almost match (ΔE ${distance.toFixed(3)}), which shows as a faint seam; make them equal or clearly different.`
    })
  }
  for (const [token, key] of [
    ['--diff-added', 'green'],
    ['--diff-removed', 'red']
  ] as const) {
    const diff = opaque(variant.tokens[token])
    const ansi = opaque(terminal[key])
    if (!diff || !ansi) {
      continue
    }
    const a = rgbaToOklch(diff)
    const b = rgbaToOklch(ansi)
    if (a.c >= MIN_CHROMA && b.c >= MIN_CHROMA && hueDistance(a.h, b.h) > 60) {
      warnings.push({
        id: `${mode}-diff-hue-${key}`,
        rule: 'diff-hue',
        mode,
        tokens: [token, `terminal.${key}`],
        message: `${token} and terminal.${key} disagree in hue (${Math.round(a.h)}° vs ${Math.round(b.h)}°), so diffs in the editor and in \`git diff\` read differently.`
      })
    }
  }
  return warnings
}

function pairWarnings(draft: ThemeStudioDraft): ThemeStudioWarning[] {
  const { light, dark } = draft
  if (!light || !dark) {
    return []
  }
  return PAIRED_TOKENS.flatMap((token) => {
    const a = opaque(light.tokens[token])
    const b = opaque(dark.tokens[token])
    if (!a || !b) {
      return []
    }
    const l = rgbaToOklch(a)
    const d = rgbaToOklch(b)
    if (l.c < MIN_CHROMA || d.c < MIN_CHROMA || hueDistance(l.h, d.h) <= 60) {
      return []
    }
    return [
      {
        id: `pair-hue-${token.slice(2)}`,
        rule: 'pair-hue' as const,
        tokens: [token],
        message: `${token} changes hue between light (${Math.round(l.h)}°) and dark (${Math.round(d.h)}°), so the theme looks like two themes.`
      }
    ]
  })
}

/** Warning-level advice for a draft: terminal colors, surface seams, diff hues, pair coherence. */
export function themeStudioWarnings(draft: ThemeStudioDraft | null): ThemeStudioWarning[] {
  if (!draft) {
    return []
  }
  return [
    ...(['light', 'dark'] as const).flatMap((mode) => {
      const variant = draft[mode]
      return variant ? terminalWarnings(mode, variant) : []
    }),
    ...pairWarnings(draft)
  ]
}
