import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  completePluginAppThemeTokens,
  type PluginThemeTokenColorRule
} from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginAppThemeCssFallback } from '../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { MATCH_TERMINAL_APP_THEME } from '../../../shared/plugin-theme-settings'
import {
  resolveTerminalPalette,
  type TerminalPaletteSettings as TerminalAppThemeSettings
} from '../../../shared/terminal-themes/terminal-theme-selection'
import type { AppThemePaint } from './document-theme'
import { hashThemeContent } from './plugin-monaco-theme'
import type { ColorProbe } from './plugin-theme-tokens'
import {
  contrastRatio,
  mix,
  readableOn,
  rgbaToHex,
  type Rgba
} from '../../../shared/color/rgba-contrast'
import { getSystemPrefersDark } from './terminal-theme'
import {
  isTerminalBackgroundLight,
  resolveOpaqueTerminalBackground
} from '../../../shared/terminal-themes/terminal-title-contrast'
import { terminalPaletteRgba } from '../../../shared/terminal-themes/terminal-palette-rgba'

export type TerminalAppTheme = AppThemePaint & {
  id: typeof MATCH_TERMINAL_APP_THEME
  tokenColors: PluginThemeTokenColorRule[]
}

const MIN_TEXT_CONTRAST = 4.5

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
  const base = terminalAppThemeBase(settings, systemPrefersDark)
  const palette = terminalPaletteRgba(activeTerminalPalette(settings, systemPrefersDark), probe)
  if (!base || !palette) {
    return null
  }
  const light = base === 'light'
  const { background, foreground, color: ansi, accent: accentColor } = palette
  const surfacesToward = (tint: Rgba) => ({
    popover: mix(tint, background, 5),
    muted: mix(tint, background, 7),
    accent: mix(tint, background, 12)
  })
  const extreme: Rgba = light ? [0, 0, 0, 1] : [255, 255, 255, 1]
  const towardText = surfacesToward(foreground)
  // Why tint away on a mid-tone background: surfaces nearer the text can leave no legible text.
  const surfaces = Object.values(towardText).every(
    (surface) => contrastRatio(extreme, surface) >= MIN_TEXT_CONTRAST
  )
    ? towardText
    : surfacesToward(light ? [255, 255, 255, 1] : [0, 0, 0, 1])
  const text = readableOn(
    foreground,
    [background, ...Object.values(surfaces)],
    light,
    MIN_TEXT_CONTRAST
  )
  // Why: the host pill paints muted text on the accent, tinted in dark over the sidebar (= background).
  const hostBadgeRule = pluginAppThemeCssFallback('--host-badge', base)
  const hostBadge = mix(
    surfaces.accent,
    background,
    hostBadgeRule && 'tint' in hostBadgeRule ? hostBadgeRule.percent : 100
  )
  const mutedText = readableOn(
    mix(foreground, background, 70),
    [background, surfaces.muted, hostBadge],
    light,
    MIN_TEXT_CONTRAST
  )
  const primaryText = accentColor
    ? [background, text].find((color) => contrastRatio(color, accentColor) >= MIN_TEXT_CONTRAST)
    : undefined
  const charts = (['blue', 'green', 'yellow', 'magenta', 'cyan'] as const).flatMap((key, index) => {
    const color = ansi(key)
    return color ? [[`--chart-${index + 1}`, rgbaToHex(color)] as const] : []
  })
  const tokens = completePluginAppThemeTokens({
    '--background': rgbaToHex(background),
    '--foreground': rgbaToHex(text),
    '--popover': rgbaToHex(surfaces.popover),
    '--muted': rgbaToHex(surfaces.muted),
    '--secondary': rgbaToHex(surfaces.muted),
    '--accent': rgbaToHex(surfaces.accent),
    '--muted-foreground': rgbaToHex(mutedText),
    '--border': rgbaToHex(mix(foreground, background, 10)),
    // Why the sidebar equals the terminal: that is what "Match Terminal" looked like before.
    '--sidebar': rgbaToHex(background),
    ...(accentColor ? { '--ring': rgbaToHex(accentColor) } : {}),
    ...(accentColor && primaryText
      ? { '--primary': rgbaToHex(accentColor), '--primary-foreground': rgbaToHex(primaryText) }
      : {}),
    ...Object.fromEntries(charts)
  })
  const tokenColors = SYNTAX_SCOPES.flatMap(([key, scope]) => {
    const color = ansi(key)
    return color ? [{ scope, settings: { foreground: rgbaToHex(color) } }] : []
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
