import {
  completePluginAppThemeTokens,
  PLUGIN_APP_THEME_REQUIRED_TOKENS,
  PLUGIN_APP_THEME_TOKENS
} from './plugin-theme-artifact'
import { pluginAppThemeCssFallback } from './plugin-theme-css-fallbacks'
import { PANEL_DESIGN_TOKEN_ALLOWLIST } from '../frames/plugin-panel-design-tokens'

const REQUIRED = new Set<string>(PLUGIN_APP_THEME_REQUIRED_TOKENS)

type PluginAppThemeToken = (typeof PLUGIN_APP_THEME_TOKENS)[number]

// Why a full record: a public token added without saying what it paints fails typecheck.
const TOKEN_ROLES: Record<PluginAppThemeToken, string> = {
  '--background': 'App canvas',
  '--editor-surface': 'Code editor and notebook background',
  '--foreground': 'Body text',
  '--card': 'Cards and panels',
  '--card-foreground': 'Text on `--card`',
  '--popover': 'Menus, popovers and dialogs',
  '--popover-foreground': 'Text on `--popover`',
  '--primary': 'Primary buttons',
  '--primary-foreground': 'Text on `--primary`',
  '--secondary': 'Secondary buttons',
  '--secondary-foreground': 'Text on `--secondary`',
  '--muted': 'Quiet fills',
  '--muted-foreground': 'Secondary text',
  '--accent': 'Hover and selected fills',
  '--accent-foreground': 'Text on `--accent`',
  '--border': 'Borders and separators',
  '--input': 'Input borders',
  '--ring': 'Focus rings',
  '--chart-1': 'Chart series 1',
  '--chart-2': 'Chart series 2',
  '--chart-3': 'Chart series 3',
  '--chart-4': 'Chart series 4',
  '--chart-5': 'Chart series 5',
  '--sidebar': 'Right sidebar and settings navigation',
  '--sidebar-foreground': 'Text on `--sidebar`',
  '--sidebar-primary': 'Primary controls in sidebars',
  '--sidebar-primary-foreground': 'Text on `--sidebar-primary`',
  '--sidebar-accent': 'Hover and selected rows in sidebars',
  '--sidebar-accent-foreground': 'Text on `--sidebar-accent`',
  '--sidebar-border': 'Sidebar borders',
  '--sidebar-ring': 'Focus rings in sidebars',
  '--worktree-sidebar': 'Left workspace sidebar',
  '--worktree-sidebar-foreground': 'Text on `--worktree-sidebar`',
  '--worktree-sidebar-accent': 'Hover and multi-selected rows in the workspace sidebar',
  '--worktree-sidebar-accent-foreground': 'Text on `--worktree-sidebar-accent`',
  '--worktree-sidebar-border': 'Workspace sidebar borders',
  '--worktree-sidebar-ring': 'Focus rings in the workspace sidebar',
  '--worktree-sidebar-active':
    'The current workspace row; may be translucent, it paints over `--worktree-sidebar`',
  '--worktree-sidebar-active-border': 'Border of the current workspace row',
  '--host-badge': 'Execution-host badge on workspaces (for example `Local`, an SSH host)',
  '--host-badge-foreground': 'Text on `--host-badge`',
  '--tab-bar': 'Strip behind tabs, including the title bar when tabs sit in it',
  '--tab-active': 'Active tab',
  '--tab-active-foreground': 'Active tab text, and inactive tab text on hover',
  '--tab-active-indicator': 'Line under the active tab',
  '--tab-inactive': 'Inactive tabs',
  '--tab-inactive-foreground': 'Inactive tab text',
  '--split-divider': 'Divider between split tab groups',
  '--split-divider-hover': 'Split divider while hovered or dragged',
  '--chat-user-message': 'Your messages in chat; may be translucent, it paints over the chat',
  '--text-link': 'Links in Markdown previews and editors',
  '--diff-added': 'Added-line hue: Monaco overview ruler and chat diff text',
  '--diff-added-background': 'Added lines in diffs',
  '--diff-added-emphasis': 'Added characters within a changed line',
  '--diff-added-gutter': 'Gutter beside added lines',
  '--diff-removed': 'Removed-line hue: Monaco overview ruler and chat diff text',
  '--diff-removed-background': 'Removed lines in diffs',
  '--diff-removed-emphasis': 'Removed characters within a changed line',
  '--diff-removed-gutter': 'Gutter beside removed lines',
  '--git-decoration-added': 'Added files in the file explorer and source control',
  '--git-decoration-modified': 'Modified files',
  '--git-decoration-deleted': 'Deleted files',
  '--git-decoration-renamed': 'Renamed files',
  '--git-decoration-untracked': 'Untracked files',
  '--git-decoration-copied': 'Copied files',
  '--git-decoration-ignored': 'Git-ignored files'
}

// Why: these mix per mode in main.css, which the derivation rules cannot express.
const MODE_MIXES: Partial<Record<PluginAppThemeToken, string>> = {
  '--worktree-sidebar-active': 'a translucent wash of `--worktree-sidebar-foreground`',
  '--worktree-sidebar-active-border': 'a mix of `--worktree-sidebar-border`',
  '--chat-user-message': '`--foreground` mixed lightly into the chat background'
}

/** What an omitted token becomes, read back from the real derivation with every other token
 *  standing in as `var(<name>)`, so the table cannot drift from what Orca applies. */
function omittedValueFor(token: PluginAppThemeToken, base: 'light' | 'dark'): string {
  const others = Object.fromEntries(
    PLUGIN_APP_THEME_TOKENS.filter((other) => other !== token).map((other) => [
      other,
      `var(${other})`
    ])
  )
  const cssFallback = pluginAppThemeCssFallback(token, base)
  if (cssFallback && 'tint' in cssFallback) {
    return `\`${cssFallback.tint}\` at ${cssFallback.percent}% opacity`
  }
  const derived = cssFallback
    ? 'mixForeground' in cssFallback
      ? `color-mix(in srgb, var(--foreground) ${cssFallback.mixForeground}%, var(${cssFallback.into ?? '--background'}))`
      : `var(${cssFallback[0]})`
    : completePluginAppThemeTokens(others)[token]
  if (derived === undefined) {
    return MODE_MIXES[token] ?? "Orca's built-in color"
  }
  const mix = /^color-mix\(in srgb, var\((--[\w-]+)\) (\d+)%, var\((--[\w-]+)\)\)$/.exec(derived)
  if (mix) {
    return `\`${mix[1]}\` mixed ${mix[2]}% into \`${mix[3]}\``
  }
  return derived.replace(/^var\((--[\w-]+)\)$/, 'same as `$1`')
}

function omittedValue(token: PluginAppThemeToken): string {
  const light = omittedValueFor(token, 'light')
  const dark = omittedValueFor(token, 'dark')
  return light === dark ? light : `light: ${light}; dark: ${dark}`
}

/** Colour token list for theme authors, rendered from the public token set. */
export function renderPluginThemeTokenReference(): string {
  const lines = [
    '# Orca app theme tokens',
    '',
    '<!-- Generated by `pnpm generate:plugin-schemas` from src/shared/plugins. Do not edit. -->',
    '',
    'Every key an app theme may set in `tokens` (see [plugin themes](plugin-themes.md)). Any other key is refused. An omitted token falls back as listed; when that source is omitted too, it falls back the same way in turn.',
    '',
    '| Token | Paints | Required | When omitted |',
    '| --- | --- | --- | --- |',
    ...PLUGIN_APP_THEME_TOKENS.map(
      (token) =>
        `| \`${token}\` | ${TOKEN_ROLES[token]} | ${REQUIRED.has(token) ? 'yes' : 'no'} | ${REQUIRED.has(token) ? '' : omittedValue(token)} |`
    ),
    '',
    '## Frame CSS variables',
    '',
    "Panel and custom editor frames get these stable variables, set from Orca's active theme and updated in place when it changes. Other tokens are not exposed to frames.",
    '',
    '| Variable | Orca token |',
    '| --- | --- |',
    ...PANEL_DESIGN_TOKEN_ALLOWLIST.map(
      (token) => `| \`--orca-${token.slice(2)}\` | \`${token}\` |`
    )
  ]
  return `${lines.join('\n')}\n`
}
