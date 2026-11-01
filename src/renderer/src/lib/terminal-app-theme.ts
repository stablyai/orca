import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  completePluginAppThemeTokens,
  type PluginThemeTokenColorRule
} from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import { MATCH_TERMINAL_APP_THEME } from '../../../shared/plugin-theme-settings'
import {
  resolveTerminalPalette,
  type TerminalPaletteSettings
} from '../../../shared/terminal-theme-selection'
import type { AppThemePaint } from './document-theme'
import { hashThemeContent } from './plugin-monaco-theme'
import { contrastRatio, type ColorProbe, type Rgba } from './plugin-theme-tokens'
import {
  getSystemPrefersDark,
  isTerminalBackgroundLight,
  resolveOpaqueTerminalBackground
} from './terminal-theme'

export type TerminalAppThemeSettings = TerminalPaletteSettings

export type TerminalAppTheme = AppThemePaint & {
  id: typeof MATCH_TERMINAL_APP_THEME
  tokenColors: PluginThemeTokenColorRule[]
}

const MIN_TEXT_CONTRAST = 4.5
// Why 3:1: a focus ring or cursor must stand out; the shared gate's 2:1 is only its floor.
const MIN_ACCENT_CONTRAST = 3

/** The palette the active terminal paints with: the mode's theme plus that mode's overrides.
 *  Why no opacity: theme surfaces must be opaque for the contrast gate. */
function activeTerminalPalette(
  settings: TerminalAppThemeSettings,
  systemPrefersDark: boolean
): ITheme | null {
  return resolveTerminalPalette(settings, systemPrefersDark).theme
}

const baseCache = new WeakMap<object, Map<boolean, 'light' | 'dark' | null>>()

/** Light or dark by the terminal background; null when it can't be read. Memoized per settings
 *  object, since every dark-mode hook asks on each store change. */
export function terminalAppThemeBase(
  settings: TerminalAppThemeSettings,
  systemPrefersDark: boolean
): 'light' | 'dark' | null {
  const cached = baseCache.get(settings)?.get(systemPrefersDark)
  if (cached !== undefined) {
    return cached
  }
  const background = resolveOpaqueTerminalBackground(
    activeTerminalPalette(settings, systemPrefersDark)?.background
  )
  const base = background ? (isTerminalBackgroundLight(background) ? 'light' : 'dark') : null
  const bySystem = baseCache.get(settings) ?? new Map()
  bySystem.set(systemPrefersDark, base)
  baseCache.set(settings, bySystem)
  return base
}

/** Whether Orca paints dark: the app theme slot for the requested mode decides when it holds a
 *  theme whose mode differs (Match Terminal follows the terminal's background). */
export function resolvePaintedDark(
  settings:
    | (TerminalAppThemeSettings &
        Pick<GlobalSettings, 'pluginAppThemeDark' | 'pluginAppThemeLight'>)
    | null
    | undefined,
  requestedDark: boolean,
  systemPrefersDark: boolean
): boolean {
  const slot = requestedDark ? settings?.pluginAppThemeDark : settings?.pluginAppThemeLight
  if (!settings || slot !== MATCH_TERMINAL_APP_THEME) {
    return requestedDark
  }
  const base = terminalAppThemeBase(settings, systemPrefersDark)
  return base ? base === 'dark' : requestedDark
}

/** The theme preference to paint the document with; keeps 'system' unless Match Terminal flips it. */
export function resolvePaintedTheme(
  settings: Parameters<typeof resolvePaintedDark>[0],
  theme: GlobalSettings['theme'] = settings?.theme ?? 'system'
): GlobalSettings['theme'] {
  const systemPrefersDark = getSystemPrefersDark()
  const requestedDark = theme === 'system' ? systemPrefersDark : theme === 'dark'
  const dark = resolvePaintedDark(
    settings && { ...settings, theme },
    requestedDark,
    systemPrefersDark
  )
  return dark === requestedDark ? theme : dark ? 'dark' : 'light'
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]
}

function mix(color: Rgba, background: Rgba, amount: number): Rgba {
  return over([color[0], color[1], color[2], amount], background)
}

function hex([r, g, b]: Rgba): string {
  return `#${[r, g, b]
    .map((channel) =>
      Math.round(Math.min(255, Math.max(0, channel)))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

/** Pushes text toward black or white until it reads on every surface; low-contrast palettes
 *  (Solarized) keep their hue instead of losing the token to the contrast gate. */
function legible(text: Rgba, surfaces: readonly Rgba[], light: boolean): Rgba {
  const extreme: Rgba = light ? [0, 0, 0, 1] : [255, 255, 255, 1]
  for (let step = 0; step <= 20; step += 1) {
    const candidate = mix(extreme, text, step / 20)
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= MIN_TEXT_CONTRAST)) {
      return candidate
    }
  }
  return extreme
}

// Why these scopes: the ones every grammar emits, mapped to the ANSI roles shells use for them.
const SYNTAX_SCOPES: readonly (readonly [keyof ITheme, string[]])[] = [
  ['brightBlack', ['comment']],
  ['green', ['string']],
  ['magenta', ['keyword', 'storage']],
  ['cyan', ['constant.numeric', 'constant.language']],
  ['blue', ['entity.name.function', 'support.function']],
  ['yellow', ['entity.name.type', 'support.type']],
  ['red', ['entity.name.tag']]
]

let last: { content: string; theme: TerminalAppTheme } | null = null

/**
 * An app theme from the terminal palette, shaped like a plugin theme so it goes through the same
 * derivation, contrast gate, startup cache and Monaco theme. Null when the palette has no
 * readable background or foreground.
 */
export function synthesizeTerminalAppTheme(
  settings: TerminalAppThemeSettings,
  systemPrefersDark: boolean,
  probe: ColorProbe
): TerminalAppTheme | null {
  const palette = activeTerminalPalette(settings, systemPrefersDark)
  const base = terminalAppThemeBase(settings, systemPrefersDark)
  const opaqueBackground = resolveOpaqueTerminalBackground(palette?.background)
  const background = opaqueBackground ? probe(opaqueBackground) : null
  const rawForeground = palette?.foreground ? probe(palette.foreground) : null
  if (!palette || !base || !background || !rawForeground) {
    return null
  }
  const light = base === 'light'
  const foreground = over(rawForeground, background)
  const ansi = (key: keyof ITheme): Rgba | null => {
    const value = palette[key]
    const parsed = typeof value === 'string' ? probe(value) : null
    return parsed ? over(parsed, background) : null
  }
  const surfacesToward = (tint: Rgba) => ({
    popover: mix(tint, background, 0.05),
    muted: mix(tint, background, 0.07),
    accent: mix(tint, background, 0.12)
  })
  const extreme: Rgba = light ? [0, 0, 0, 1] : [255, 255, 255, 1]
  const towardText = surfacesToward(foreground)
  // Why tint away on a mid-tone background: surfaces nearer the text can leave no legible text.
  const surfaces = Object.values(towardText).every(
    (surface) => contrastRatio(extreme, surface) >= MIN_TEXT_CONTRAST
  )
    ? towardText
    : surfacesToward(light ? [255, 255, 255, 1] : [0, 0, 0, 1])
  const text = legible(foreground, [background, ...Object.values(surfaces)], light)
  const mutedText = legible(mix(foreground, background, 0.7), [background, surfaces.muted], light)
  const accentColor = [ansi('blue'), ansi('brightBlue')].find(
    (color): color is Rgba =>
      color !== null && contrastRatio(color, background) >= MIN_ACCENT_CONTRAST
  )
  const primaryText = accentColor
    ? [background, text].find((color) => contrastRatio(color, accentColor) >= MIN_TEXT_CONTRAST)
    : undefined
  const charts = (['blue', 'green', 'yellow', 'magenta', 'cyan'] as const).flatMap((key, index) => {
    const color = ansi(key)
    return color ? [[`--chart-${index + 1}`, hex(color)] as const] : []
  })
  const tokens = completePluginAppThemeTokens({
    '--background': hex(background),
    '--foreground': hex(text),
    '--popover': hex(surfaces.popover),
    '--muted': hex(surfaces.muted),
    '--secondary': hex(surfaces.muted),
    '--accent': hex(surfaces.accent),
    '--muted-foreground': hex(mutedText),
    '--border': hex(mix(foreground, background, 0.1)),
    // Why the sidebar equals the terminal: that is what "Match Terminal" looked like before.
    '--sidebar': hex(background),
    ...(accentColor ? { '--ring': hex(accentColor) } : {}),
    ...(accentColor && primaryText
      ? { '--primary': hex(accentColor), '--primary-foreground': hex(primaryText) }
      : {}),
    ...Object.fromEntries(charts)
  })
  const tokenColors = SYNTAX_SCOPES.flatMap(([key, scope]) => {
    const color = ansi(key)
    return color ? [{ scope, settings: { foreground: hex(color) } }] : []
  })
  const content = JSON.stringify({ base, tokens, tokenColors })
  // Why reuse: settings writes hand out fresh arrays, and a fresh theme object would repaint :root.
  if (!last || last.content !== content) {
    last = {
      content,
      theme: {
        id: MATCH_TERMINAL_APP_THEME,
        revision: hashThemeContent(content),
        base,
        tokens,
        tokenColors
      }
    }
  }
  return last.theme
}
