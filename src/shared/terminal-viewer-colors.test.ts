import { describe, expect, it } from 'vitest'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import {
  resolveConfiguredTerminalColors,
  resolveRepoTerminalViewerColorsByHost
} from './terminal-viewer-colors'

const base = {
  theme: 'system' as const,
  terminalThemeDark: 'Ghostty Default Style Dark',
  terminalUseSeparateLightTheme: true,
  terminalThemeLight: 'Builtin Tango Light'
}

const CUSTOM_THEME = {
  id: 'ghostty:repo-accent',
  name: 'Repo Accent',
  source: 'ghostty' as const,
  mode: 'dark' as const,
  terminal: { background: '#101820', foreground: '#f2aa4c', red: '#e06c75' },
  importedAt: '2026-01-01T00:00:00.000Z'
}

describe('the terminal colours a host configures', () => {
  it('uses the light theme for a light appearance, so a light user is not told dark', () => {
    expect(resolveConfiguredTerminalColors(base, false)).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    expect(resolveConfiguredTerminalColors({ ...base, theme: 'light' }, true)).toEqual({
      foreground: '#2e3434',
      background: '#ffffff'
    })
    expect(resolveConfiguredTerminalColors(base, true)).toEqual({
      foreground: '#ffffff',
      background: '#282c34'
    })
  })

  it('follows the selected catalog theme and colour overrides', () => {
    const name = 'Tokyo Night'
    const selected = TERMINAL_THEME_CATALOG[name]
    expect(selected).toBeDefined()
    expect(resolveConfiguredTerminalColors({ ...base, terminalThemeDark: name }, true)).toEqual({
      foreground: selected?.foreground,
      background: selected?.background
    })
    expect(
      resolveConfiguredTerminalColors(
        { ...base, terminalColorOverrides: { background: '#101010' } },
        true
      )
    ).toEqual({ foreground: '#ffffff', background: '#101010' })
    expect(
      resolveConfiguredTerminalColors({ ...base, terminalThemeDark: 'no such theme' }, true)
    ).toEqual({ foreground: '#ffffff', background: '#282c34' })
  })

  it('reports colours the way a pane paints them: parsed, opaque, lower-case hex', () => {
    // Short and upper-case hex, an rgb() override, and background opacity all reach a pane
    // through the same parse; the reply must be what that pane's xterm reports.
    expect(
      resolveConfiguredTerminalColors(
        {
          ...base,
          terminalColorOverrides: { foreground: '#ABC', background: 'rgb(1, 2, 3)' },
          terminalBackgroundOpacity: 0.5
        },
        true
      )
    ).toEqual({ foreground: '#aabbcc', background: '#000000' })
    expect(
      resolveConfiguredTerminalColors(
        {
          ...base,
          terminalColorOverrides: { background: '#ABCDEF' },
          terminalBackgroundOpacity: 0.5
        },
        true
      )
    ).toEqual({ foreground: '#ffffff', background: '#abcdef' })
    // An override the pane cannot parse paints the ThemeService default, not the theme colour.
    expect(
      resolveConfiguredTerminalColors(
        { ...base, terminalColorOverrides: { foreground: 'red' } },
        true
      )
    ).toEqual({ foreground: '#ffffff', background: '#282c34' })
  })
})

describe('the project colours a host seeds from persisted repos', () => {
  const settings = { ...base, terminalCustomThemes: [CUSTOM_THEME] }
  const local = (id: string, terminalTheme?: { dark?: string; light?: string }) => ({
    id,
    connectionId: null,
    terminalTheme
  })

  it('keys each themed project by its execution host, by the variant the appearance selects', () => {
    const byHost = resolveRepoTerminalViewerColorsByHost(
      settings,
      [
        local('solarized', { dark: 'Solarized Dark', light: 'Solarized Light' }),
        local('custom', { dark: `custom:${CUSTOM_THEME.id}` }),
        local('light-only', { light: 'One Light' }),
        local('plain'),
        // The same repo id on this host and on an SSH host: each host gets its own entry.
        { ...local('solarized', { dark: 'Tokyo Night' }), connectionId: 'ssh-1' },
        { ...local('remote', { dark: 'Solarized Dark' }), executionHostId: 'ssh:ssh-1' as const },
        { ...local('other', { dark: 'Solarized Dark' }), executionHostId: 'ssh:ssh-2' as const },
        // Paired-runtime projects have no owner this app pushes colours to.
        { ...local('hosted', { dark: 'Solarized Dark' }), executionHostId: 'runtime:r1' as const },
        local('gone', { dark: 'No Such Theme' })
      ],
      true
    )
    expect(byHost).toEqual({
      local: {
        solarized: { foreground: '#839496', background: '#002b36' },
        custom: { foreground: '#f2aa4c', background: '#101820' },
        // A light-only pick still names the project themed (the renderer publishes it too);
        // in dark mode its colours are the global dark theme's.
        'light-only': { foreground: '#ffffff', background: '#282c34' }
      },
      'ssh:ssh-1': {
        solarized: { foreground: '#c0caf5', background: '#1a1b26' },
        remote: { foreground: '#839496', background: '#002b36' }
      },
      'ssh:ssh-2': { other: { foreground: '#839496', background: '#002b36' } }
    })
    expect(
      resolveRepoTerminalViewerColorsByHost(
        settings,
        [local('light-only', { light: 'One Light' })],
        false
      )
    ).toEqual({ local: { 'light-only': { foreground: '#383a42', background: '#fafafa' } } })
  })

  it('resolves a stored pick the way the renderer normalizes it (trimmed), per project', () => {
    const byHost = resolveRepoTerminalViewerColorsByHost(
      settings,
      [
        local('padded', { dark: '  Solarized Dark ' }),
        { ...local('string'), terminalTheme: JSON.parse('"Solarized Dark"') },
        { ...local('nested'), terminalTheme: JSON.parse('{"dark":{"name":"Solarized Dark"}}') }
      ],
      true
    )
    expect(byHost).toEqual({ local: { padded: { foreground: '#839496', background: '#002b36' } } })
  })

  it('cannot be steered by a __proto__ repo id', () => {
    const byHost = resolveRepoTerminalViewerColorsByHost(
      settings,
      [local('__proto__', { dark: 'Solarized Dark' })],
      true
    )
    expect(Object.getPrototypeOf(byHost)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(byHost.local)).toBe(Object.prototype)
    expect(Object.keys(byHost.local)).toEqual(['__proto__'])
  })
})
