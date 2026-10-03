import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { terminalViewColorQueryReplyColors } from '../../../shared/terminal-view-attributes'
import {
  resolveConfiguredTerminalColors,
  resolveRepoTerminalViewerColorsByHost
} from '../../../shared/terminal-viewer-colors'
import type { TerminalViewAttributes } from '../../../shared/terminal-view-attributes'
import { resolveTerminalViewAttributes } from '../../../shared/terminal-view-attributes-composition'
import { resolveRepoTerminalViewAttributesByHost } from '../../../shared/repo-terminal-view-attributes-by-host'
import { getRepoTerminalThemeHostId } from '../../../shared/terminal-theme-execution-host'
import {
  composeActiveTerminalTheme,
  publishTerminalViewAttributesAtAppStart
} from '../components/terminal-pane/terminal-appearance'
import { composeRepoTerminalViewAttributesByHost } from '../components/terminal-pane/repo-terminal-view-attributes-publisher'
import {
  _resetTerminalViewAttributesPublisherForTest,
  composeTerminalViewAttributes
} from '../components/terminal-pane/terminal-view-attributes-publisher'
import {
  BUILTIN_TERMINAL_THEME_NAMES,
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  applyRepoTerminalThemeOverride,
  getBuiltinTheme,
  resolveEffectiveTerminalAppearance
} from './terminal-theme'

type AppearanceSettings = Pick<
  GlobalSettings,
  | 'theme'
  | 'terminalThemeDark'
  | 'terminalDividerColorDark'
  | 'terminalUseSeparateLightTheme'
  | 'terminalThemeLight'
  | 'terminalCustomThemes'
  | 'terminalDividerColorLight'
>

const CUSTOM_THEME = {
  id: 'ghostty:repo-accent',
  name: 'Repo Accent',
  source: 'ghostty' as const,
  mode: 'dark' as const,
  terminal: { background: '#101820', foreground: '#f2aa4c', red: '#e06c75' },
  importedAt: '2026-01-01T00:00:00.000Z'
}

function makeSettings(overrides: Partial<AppearanceSettings> = {}): AppearanceSettings {
  return {
    theme: 'dark',
    terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
    terminalDividerColorDark: '#3f3f46',
    terminalUseSeparateLightTheme: true,
    terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
    terminalDividerColorLight: '#d4d4d8',
    terminalCustomThemes: [CUSTOM_THEME],
    ...overrides
  }
}

describe('applyRepoTerminalThemeOverride', () => {
  it('returns the identical settings object when there is no override', () => {
    const settings = makeSettings()
    expect(applyRepoTerminalThemeOverride(settings, undefined)).toBe(settings)
  })

  it('returns the identical settings object when no override variant resolves', () => {
    const settings = makeSettings()
    expect(applyRepoTerminalThemeOverride(settings, { dark: 'Nope', light: 'custom:gone' })).toBe(
      settings
    )
  })

  it('falls back to global for a variant of another shape instead of throwing', () => {
    const settings = makeSettings()
    const malformed = JSON.parse('{"dark":{"name":"Dracula"},"light":7}')
    expect(applyRepoTerminalThemeOverride(settings, malformed)).toBe(settings)
  })

  it('uses a dark-only override in dark mode', () => {
    const merged = applyRepoTerminalThemeOverride(makeSettings(), { dark: 'Tango Dark' })
    expect(resolveEffectiveTerminalAppearance(merged, true).themeName).toBe('Tango Dark')
  })

  it('keeps the global light theme for a dark-only override when global separate-light is on', () => {
    const merged = applyRepoTerminalThemeOverride(makeSettings({ theme: 'light' }), {
      dark: 'Tango Dark'
    })
    expect(resolveEffectiveTerminalAppearance(merged, false).themeName).toBe(
      DEFAULT_TERMINAL_THEME_LIGHT
    )
  })

  it('uses the dark override in light mode when global separate-light is off', () => {
    const merged = applyRepoTerminalThemeOverride(
      makeSettings({ theme: 'light', terminalUseSeparateLightTheme: false }),
      { dark: 'Tango Dark' }
    )
    expect(resolveEffectiveTerminalAppearance(merged, false).themeName).toBe('Tango Dark')
  })

  it('uses a light override even when global separate-light is off', () => {
    const merged = applyRepoTerminalThemeOverride(
      makeSettings({ theme: 'light', terminalUseSeparateLightTheme: false }),
      { light: 'One Light' }
    )
    expect(merged.terminalUseSeparateLightTheme).toBe(true)
    expect(resolveEffectiveTerminalAppearance(merged, false).themeName).toBe('One Light')
  })

  it('falls back to global for an unknown theme name', () => {
    const merged = applyRepoTerminalThemeOverride(makeSettings(), {
      dark: 'Not A Real Theme',
      light: 'One Light'
    })
    expect(merged.terminalThemeDark).toBe(DEFAULT_TERMINAL_THEME_DARK)
    expect(resolveEffectiveTerminalAppearance(merged, true).themeName).toBe(
      DEFAULT_TERMINAL_THEME_DARK
    )
  })

  it('resolves a custom selection that exists in the global custom themes', () => {
    const selection = `custom:${CUSTOM_THEME.id}`
    const merged = applyRepoTerminalThemeOverride(makeSettings(), { dark: selection })
    const appearance = resolveEffectiveTerminalAppearance(merged, true)
    expect(appearance.themeName).toBe(selection)
    expect(appearance.theme?.background).toBe('#101820')
  })

  it('falls back to global when a custom selection is missing', () => {
    const settings = makeSettings({ terminalCustomThemes: [] })
    const merged = applyRepoTerminalThemeOverride(settings, {
      dark: `custom:${CUSTOM_THEME.id}`
    })
    expect(merged).toBe(settings)
    expect(resolveEffectiveTerminalAppearance(merged, true).themeName).toBe(
      DEFAULT_TERMINAL_THEME_DARK
    )
  })

  it('picks the matching variant for the system theme', () => {
    const merged = applyRepoTerminalThemeOverride(makeSettings({ theme: 'system' }), {
      dark: 'Tango Dark',
      light: 'One Light'
    })
    expect(resolveEffectiveTerminalAppearance(merged, true).themeName).toBe('Tango Dark')
    expect(resolveEffectiveTerminalAppearance(merged, false).themeName).toBe('One Light')
  })
})

describe('applyRepoTerminalThemeOverride built-in lookup', () => {
  it('falls back to global for Object.prototype member names', () => {
    const settings = makeSettings()
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(getBuiltinTheme(name)).toBeNull()
      expect(applyRepoTerminalThemeOverride(settings, { dark: name, light: name })).toBe(settings)
    }
  })
})

describe("main's pre-loaded attributes match what the renderer paints and publishes", () => {
  // Why byte-identical: every PTY owner and main's responder compare the two by value; a
  // mismatch reads as a theme change and drops the colours a running TUI set itself.
  // The pane pipeline (applyTerminalAppearance) is the ground truth of what a visible xterm paints.
  const paneAttributes = (
    settings: GlobalSettings,
    systemPrefersDark: boolean
  ): TerminalViewAttributes => {
    const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
    const theme = composeActiveTerminalTheme(
      appearance.theme ?? getBuiltinTheme(appearance.themeName),
      settings
    )
    return composeTerminalViewAttributes(theme, appearance.mode, settings)
  }
  const publishedAttributes = (
    settings: GlobalSettings,
    systemPrefersDark: boolean
  ): TerminalViewAttributes | null => {
    _resetTerminalViewAttributesPublisherForTest()
    let sent: TerminalViewAttributes | null = null
    publishTerminalViewAttributesAtAppStart(settings, systemPrefersDark, (attributes) => {
      sent = attributes
      return true
    })
    return sent
  }
  const settingsVariants: Partial<GlobalSettings>[] = [
    {},
    { theme: 'light' },
    { theme: 'light', terminalUseSeparateLightTheme: false },
    { terminalColorOverrides: { foreground: '#ABC', background: 'rgb(1, 2, 3)' } },
    { terminalColorOverrides: { background: '#abcdef80' }, terminalBackgroundOpacity: 0.5 },
    { terminalColorOverrides: { foreground: 'red' }, terminalBackgroundOpacity: 0.9 },
    { terminalThemeDark: 'No Such Theme', terminalThemeLight: 'custom:gone' },
    { terminalCursorStyle: 'bar', terminalCursorBlink: true },
    { terminalCursorStyle: 'underline', terminalCursorBlink: false, terminalCursorOpacity: 0.5 },
    { terminalCursorOpacity: 0.25, terminalColorOverrides: { cursor: '#FF00FF' } },
    { terminalCursorOpacity: 0.5, terminalColorOverrides: { cursor: 'rgba(1, 2, 3, 0.5)' } },
    { terminalColorOverrides: { red: '#F00', brightWhite: 'rgb(300, 0, 999)' } },
    { terminalBackgroundOpacity: 1, terminalMinimumContrastRatio: 4.5 },
    { terminalBackgroundOpacity: 0.7, terminalCursorOpacity: 0.7, terminalCursorBlink: true }
  ]
  const themeNames = [...BUILTIN_TERMINAL_THEME_NAMES, `custom:${CUSTOM_THEME.id}`]

  it('for the global theme, across the catalog and every override shape', () => {
    for (const variant of settingsVariants) {
      for (const name of themeNames) {
        const settings: GlobalSettings = {
          ...getDefaultSettings('/tmp'),
          ...makeSettings(),
          terminalThemeDark: name,
          terminalThemeLight: name,
          ...variant
        }
        for (const systemPrefersDark of [true, false]) {
          const label = `${name} ${JSON.stringify(variant)} dark=${systemPrefersDark}`
          const painted = paneAttributes(settings, systemPrefersDark)
          const preloaded = resolveTerminalViewAttributes(settings, systemPrefersDark)
          expect(preloaded, label).toEqual(painted)
          expect(publishedAttributes(settings, systemPrefersDark), label).toEqual(painted)
          expect(resolveConfiguredTerminalColors(settings, systemPrefersDark), label).toEqual(
            terminalViewColorQueryReplyColors(painted)
          )
        }
      }
    }
  })

  it('for every themed project on every host, with the same projects included', () => {
    const repos = [
      { id: 'solarized', connectionId: null, terminalTheme: { dark: 'Solarized Dark' } },
      { id: 'light-only', connectionId: null, terminalTheme: { light: 'One Light' } },
      { id: 'custom', connectionId: null, terminalTheme: { dark: `custom:${CUSTOM_THEME.id}` } },
      { id: 'gone', connectionId: null, terminalTheme: { dark: 'No Such Theme' } },
      { id: 'padded', connectionId: null, terminalTheme: { dark: ' Tokyo Night ' } },
      { id: 'plain', connectionId: null },
      { id: 'remote', connectionId: 'ssh-1', terminalTheme: { dark: 'Solarized Dark' } },
      // The same repo id as a local project, themed differently on its SSH host.
      { id: 'solarized', executionHostId: 'ssh:ssh-1' as const, terminalTheme: { dark: 'Nord' } },
      // ...and on a second SSH host, so parity is proven per SSH host, not per local/remote.
      { id: 'solarized', connectionId: 'ssh-2', terminalTheme: { dark: 'Dracula' } },
      { id: 'hosted', executionHostId: 'runtime:r1' as const, terminalTheme: { dark: 'One Light' } }
    ]
    for (const variant of settingsVariants) {
      const settings: GlobalSettings = {
        ...getDefaultSettings('/tmp'),
        ...makeSettings(),
        ...variant
      }
      for (const systemPrefersDark of [true, false]) {
        const label = `${JSON.stringify(variant)} dark=${systemPrefersDark}`
        const published = composeRepoTerminalViewAttributesByHost(
          { settings, repos },
          systemPrefersDark
        )
        expect(
          Object.fromEntries(
            Object.entries(published).map(([hostId, byRepoId]) => [hostId, Object.keys(byRepoId)])
          ),
          label
        ).toEqual({
          local: ['solarized', 'light-only', 'custom', 'padded'],
          'ssh:ssh-1': ['remote', 'solarized'],
          'ssh:ssh-2': ['solarized']
        })
        // What each themed project's pane paints, through the pane pipeline.
        for (const [hostId, byRepoId] of Object.entries(published)) {
          for (const [repoId, attributes] of Object.entries(byRepoId)) {
            const repo = repos.find(
              (candidate) =>
                candidate.id === repoId && getRepoTerminalThemeHostId(candidate) === hostId
            )
            expect(repo, `${hostId} ${repoId}`).toBeDefined()
            const normalized = {
              dark: repo?.terminalTheme?.dark?.trim(),
              light: repo?.terminalTheme?.light
            }
            expect(attributes, `${hostId} ${repoId} ${label}`).toEqual(
              paneAttributes(
                applyRepoTerminalThemeOverride(settings, normalized),
                systemPrefersDark
              )
            )
          }
        }
        expect(
          resolveRepoTerminalViewAttributesByHost(settings, repos, systemPrefersDark),
          label
        ).toEqual(published)
        expect(
          resolveRepoTerminalViewerColorsByHost(settings, repos, systemPrefersDark),
          label
        ).toEqual(
          Object.fromEntries(
            Object.entries(published).map(([hostId, byRepoId]) => [
              hostId,
              Object.fromEntries(
                Object.entries(byRepoId).map(([repoId, attributes]) => [
                  repoId,
                  terminalViewColorQueryReplyColors(attributes)
                ])
              )
            ])
          )
        )
      }
    }
  })
})
