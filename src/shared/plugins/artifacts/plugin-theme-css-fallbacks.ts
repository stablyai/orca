import type { PluginThemeDerivationRule } from './plugin-theme-artifact'

/** A derivation, or `tint`: `color-mix(in srgb, <tint> <percent>%, <into> or transparent)`. */
export type PluginThemeCssFallbackRule =
  | PluginThemeDerivationRule
  | { tint: string; percent: number; into?: string }

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
  '--worktree-sidebar-active': tint('--worktree-sidebar-foreground', 8, 10),
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
  '--chat-link': { mixForeground: 30, into: '--text-link' },
  '--status-success-background': { tint: '--status-success', percent: 10 },
  '--status-warning-text': {
    light: { tint: '--status-warning', percent: 70, into: '--foreground' },
    dark: ['--status-warning']
  },
  // At the default chat contrast setting.
  '--chat-canvas': { light: ['--background'], dark: { mixForeground: 5 } },
  '--chat-foreground': {
    light: { mixForeground: 82, into: '--chat-canvas' },
    dark: { mixForeground: 78, into: '--chat-canvas' }
  },
  '--chat-foreground-strong': {
    light: { mixForeground: 92, into: '--chat-canvas' },
    dark: { mixForeground: 90, into: '--chat-canvas' }
  },
  '--chat-user-message': {
    light: { mixForeground: 4, into: '--chat-canvas' },
    dark: { mixForeground: 7, into: '--chat-canvas' }
  },
  '--chat-bold-foreground': ['--chat-foreground-strong'],
  '--chat-muted-foreground': {
    light: ['--muted-foreground'],
    dark: { tint: '--muted-foreground', percent: 83, into: '--chat-canvas' }
  },
  '--chat-code-foreground': { mixForeground: 85, into: '--chat-canvas' },
  '--chat-inline-code-foreground': ['--chat-code-foreground'],
  '--chat-inline-code': {
    light: { mixForeground: 4, into: '--chat-canvas' },
    dark: { tint: '--foreground', percent: 6 }
  },
  '--chat-code-block': {
    light: { mixForeground: 2, into: '--chat-canvas' },
    dark: { tint: '--foreground', percent: 3.5 }
  },
  '--chat-selection': {
    light: { tint: '--text-link', percent: 30, into: '--chat-canvas' },
    dark: { tint: '--text-link', percent: 40, into: '--chat-canvas' }
  },
  '--chat-selection-foreground': ['--foreground']
}

export function pluginAppThemeCssFallback(
  token: string,
  base: 'light' | 'dark'
): PluginThemeCssFallbackRule | undefined {
  const rule = PLUGIN_APP_THEME_CSS_FALLBACKS[token]
  return rule && 'light' in rule ? rule[base] : rule
}
