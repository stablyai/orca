import type { CodeEditorThemeChoice } from '../../../shared/plugin-appearance-settings-types'
import type { PluginThemeRegistration } from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import { pluginAppThemeCssFallback } from '../../../shared/plugins/artifacts/plugin-theme-css-fallbacks'
import { derivePluginMonacoTheme, type PluginMonacoTheme } from './plugin-monaco-theme'
import type { AppThemePaint } from './document-theme'
import { safePluginThemeTokens, type ColorProbe } from './plugin-theme-tokens'

type ThemeBase = 'light' | 'dark'

/** Colors for the code surfaces Orca paints itself (notebook cells, code excerpts, prompt box). */
export type CodeEditorColors = {
  background: string
  foreground: string
  mutedForeground: string
  border: string
}

/** An editor theme chosen apart from the app theme; its base can differ from the app's mode. */
export type CodeEditorThemeOverride = { base: ThemeBase; colors: CodeEditorColors }

export type CodeEditorTheme = {
  /** Null keeps Monaco's built-in vs / vs-dark. */
  monaco: PluginMonacoTheme | null
  /** Null while the editor follows the app theme. */
  override: CodeEditorThemeOverride | null
}

// Why Monaco's own vs / vs-dark colors: Orca's code surfaces must match what Monaco paints.
const BUILT_IN_COLORS: Record<ThemeBase, CodeEditorColors> = {
  light: {
    background: '#fffffe',
    foreground: '#000000',
    mutedForeground: '#237893',
    border: '#c8c8c8'
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    mutedForeground: '#858585',
    border: '#454545'
  }
}

/** A saved choice's theme; null follows the app, also for a disabled or removed plugin. */
export function findCodeEditorTheme(
  choice: CodeEditorThemeChoice | null | undefined,
  themes: readonly PluginThemeRegistration[]
): ThemeBase | PluginThemeRegistration | null {
  if (choice === 'light' || choice === 'dark') {
    return choice
  }
  return themes.find((theme) => theme.id === choice) ?? null
}

/** A token as main.css would paint it from these tokens: the theme's value, else its CSS fallback. */
function readThemeToken(
  tokens: Readonly<Record<string, string>>,
  base: ThemeBase,
  token: string
): string {
  if (tokens[token]) {
    return tokens[token]
  }
  const rule = pluginAppThemeCssFallback(token, base)
  const read = (source: string): string => readThemeToken(tokens, base, source)
  if (!rule) {
    return ''
  }
  if ('tint' in rule) {
    const hue = read(rule.tint)
    return hue ? `color-mix(in srgb, ${hue} ${rule.percent}%, transparent)` : ''
  }
  if ('mixForeground' in rule) {
    const foreground = read('--foreground')
    const into = read(rule.into ?? '--background')
    return foreground && into
      ? `color-mix(in srgb, ${foreground} ${rule.mixForeground}%, ${into})`
      : ''
  }
  return rule.map(read).find(Boolean) ?? ''
}

function monacoColors(theme: PluginMonacoTheme, base: ThemeBase): CodeEditorColors {
  const colors = theme.data.colors
  const fallback = BUILT_IN_COLORS[base]
  return {
    background: colors['editor.background'] ?? fallback.background,
    foreground: colors['editor.foreground'] ?? fallback.foreground,
    mutedForeground: colors['editorLineNumber.foreground'] ?? fallback.mutedForeground,
    border: colors['editorWidget.border'] ?? fallback.border
  }
}

/** The theme every Monaco surface uses for the app's current mode. */
export function resolveCodeEditorTheme(input: {
  dark: boolean
  /** The app theme painted for this mode (a plugin's or Match Terminal's), if any. */
  appTheme: (AppThemePaint & Pick<PluginThemeRegistration, 'tokenColors'>) | null
  selected: ThemeBase | PluginThemeRegistration | null
  /** The tokens the app theme painted, after its contrast check. */
  appPainted: Readonly<Record<string, string>>
  /** A painted document CSS variable, for following the app theme. */
  readDocument: (token: string) => string
  probe: ColorProbe
}): CodeEditorTheme {
  const { appTheme, selected } = input
  const appBase: ThemeBase = input.dark ? 'dark' : 'light'
  const sameAsApp =
    selected === null ||
    (typeof selected === 'string'
      ? selected === appBase && !appTheme
      : selected.id === appTheme?.id)
  if (sameAsApp) {
    return {
      // Why read the document: a followed editor matches what was painted, built-ins included.
      monaco: appTheme
        ? derivePluginMonacoTheme({
            base: appTheme.base,
            read: input.readDocument,
            painted: input.appPainted,
            probe: input.probe,
            tokenColors: appTheme.tokenColors
          })
        : null,
      override: null
    }
  }
  if (typeof selected === 'string') {
    return { monaco: null, override: { base: selected, colors: BUILT_IN_COLORS[selected] } }
  }
  // Why the theme's own tokens: the document shows the app theme. The same contrast gate as an
  // app theme drops unreadable ones; no built-ins, as the derivation has its own fallbacks.
  const tokens = safePluginThemeTokens(selected.tokens, selected.base, {}, input.probe)
  const monaco = derivePluginMonacoTheme({
    base: selected.base,
    read: (token) => readThemeToken(tokens, selected.base, token),
    painted: tokens,
    probe: input.probe,
    tokenColors: selected.tokenColors
  })
  return {
    monaco,
    override: {
      base: selected.base,
      colors: monaco ? monacoColors(monaco, selected.base) : BUILT_IN_COLORS[selected.base]
    }
  }
}

const COLOR_PROPERTIES = [
  ['background', '--code-editor-background'],
  ['foreground', '--code-editor-foreground'],
  ['mutedForeground', '--code-editor-muted-foreground'],
  ['border', '--code-editor-border']
] as const

type CodeEditorColorsRoot = Pick<HTMLElement, 'dataset'> & {
  style: Pick<CSSStyleDeclaration, 'setProperty' | 'removeProperty'>
}

/** Publishes an override's colors on the root; `.code-editor-colors` surfaces read them. */
export function paintCodeEditorColors(
  override: CodeEditorThemeOverride | null,
  root: CodeEditorColorsRoot = document.documentElement
): void {
  for (const [key, property] of COLOR_PROPERTIES) {
    if (override) {
      root.style.setProperty(property, override.colors[key])
    } else {
      root.style.removeProperty(property)
    }
  }
  if (override) {
    root.dataset.codeEditorTheme = override.base
  } else {
    delete root.dataset.codeEditorTheme
  }
}
