import type { PluginThemeDerivationRule } from './plugin-theme-artifact'

/** A derivation, or `tint`: `color-mix(in srgb, <tint> <percent>%, transparent)`. */
export type PluginThemeCssFallbackRule =
  | PluginThemeDerivationRule
  | { tint: string; percent: number }

const tint = (token: string, light: number, dark: number) => ({
  light: { tint: token, percent: light },
  dark: { tint: token, percent: dark }
})

/**
 * What main.css paints for a token the theme omits (or the contrast check drops), derived from
 * whatever the theme did paint. Never painted; the contrast check and the token reference read
 * it. Internal chat colors appear so the chat bubble is checked against its real text. Keep in
 * sync with main.css.
 */
const PLUGIN_APP_THEME_CSS_FALLBACKS: Record<
  string,
  PluginThemeCssFallbackRule | Record<'light' | 'dark', PluginThemeCssFallbackRule>
> = {
  '--tab-bar': ['--card'],
  // Why per base: a white light --card can't be lifted, so light recesses the inactive tabs.
  '--tab-active': { light: ['--tab-bar'], dark: { mixForeground: 6, into: '--tab-bar' } },
  '--tab-active-foreground': ['--foreground'],
  '--tab-active-indicator': ['--tab-active-foreground'],
  '--tab-inactive': { light: { mixForeground: 4, into: '--tab-bar' }, dark: ['--tab-bar'] },
  '--tab-inactive-foreground': ['--muted-foreground'],
  '--host-badge': { light: ['--accent'], dark: { tint: '--accent', percent: 80 } },
  '--host-badge-foreground': ['--muted-foreground'],
  '--diff-added': ['--git-decoration-added'],
  '--diff-removed': ['--git-decoration-deleted'],
  '--diff-added-background': tint('--diff-added', 13, 16),
  '--diff-added-emphasis': tint('--diff-added', 15, 20),
  '--diff-added-gutter': tint('--diff-added', 26, 30),
  '--diff-removed-background': tint('--diff-removed', 11, 18),
  '--diff-removed-emphasis': tint('--diff-removed', 15, 20),
  '--diff-removed-gutter': tint('--diff-removed', 22, 32),
  '--chat-diff-added': { mixForeground: 30, into: '--diff-added' },
  '--chat-diff-removed': { mixForeground: 30, into: '--diff-removed' },
  // At the default chat contrast setting.
  '--chat-canvas': { light: ['--background'], dark: { mixForeground: 5 } },
  '--chat-foreground-strong': {
    light: { mixForeground: 92, into: '--chat-canvas' },
    dark: { mixForeground: 90, into: '--chat-canvas' }
  }
}

export function pluginAppThemeCssFallback(
  token: string,
  base: 'light' | 'dark'
): PluginThemeCssFallbackRule | undefined {
  const rule = PLUGIN_APP_THEME_CSS_FALLBACKS[token]
  return rule && 'light' in rule ? rule[base] : rule
}
