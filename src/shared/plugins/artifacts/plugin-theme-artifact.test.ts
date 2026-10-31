import { describe, expect, it } from 'vitest'
import { isPluginThemeRegistration, parsePluginAppThemeArtifact } from './plugin-theme-artifact'
import {
  isPluginTerminalThemeRegistration,
  parsePluginTerminalThemeArtifact
} from './plugin-terminal-theme-artifact'

const parseApp = (value: unknown) => () =>
  parsePluginAppThemeArtifact(JSON.stringify(value), 'strict')

describe('plugin app theme artifacts', () => {
  it('accepts public tokens with bounded color values', () => {
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          base: 'light',
          tokens: { '--background': '#ffffff', '--foreground': 'oklch(0.2 0.02 250)' }
        })
      ).tokens
    ).toMatchObject({ '--background': '#ffffff', '--foreground': 'oklch(0.2 0.02 250)' })
  })

  it.each([
    ['a private token', { base: 'dark', tokens: { '--internal-gap': '#000' } }],
    ['a URL', { base: 'dark', tokens: { '--background': 'url(x)' } }],
    ['a var() chain', { base: 'dark', tokens: { '--background': 'var(--a)' } }],
    ['declaration syntax', { base: 'dark', tokens: { '--background': '#000; color: red' } }],
    ['no tokens', { base: 'dark', tokens: {} }],
    [
      'transparent',
      { base: 'dark', tokens: { '--background': 'transparent', '--foreground': '#fff' } }
    ],
    ['an unknown key', { base: 'dark', tokens: { '--border': '#000' }, extra: 1 }]
  ])('rejects %s', (_label, value) => {
    expect(parseApp(value)).toThrow()
  })

  it('skips unknown tokens and keys at runtime so newer themes still load', () => {
    const theme = parsePluginAppThemeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        base: 'dark',
        tokens: { '--background': '#000', '--foreground': '#fff', '--future': '#123' },
        future: true
      })
    )
    expect(theme.tokens).not.toHaveProperty('--future')
    expect(parseApp({ schemaVersion: 2, base: 'dark', tokens: {} })).toThrow()
  })

  it('reads VS Code-shaped tokenColors, strict for authors and tolerant at runtime', () => {
    const base = { base: 'dark', tokens: { '--background': '#000', '--foreground': '#fff' } }
    const keyword = { name: 'Keywords', scope: ['keyword'], settings: { foreground: '#ff79c6' } }
    expect(parseApp({ ...base, tokenColors: [keyword] })().tokenColors).toEqual([keyword])
    expect(
      parseApp({ ...base, tokenColors: [{ scope: 'x', settings: { foreground: 'red' } }] })
    ).toThrow()
    expect(
      parseApp({ ...base, tokenColors: [{ scope: 'x', settings: { fontStyle: 'wavy' } }] })
    ).toThrow()
    expect(
      parsePluginAppThemeArtifact(
        JSON.stringify({
          ...base,
          tokenColors: [
            { ...keyword, settings: { ...keyword.settings, background: '#000' } },
            { scope: 'x', settings: { foreground: 'red' } },
            'junk'
          ]
        })
      ).tokenColors
    ).toEqual([{ scope: ['keyword'], settings: { foreground: '#ff79c6' } }])
  })

  it('validates registrations crossing IPC', () => {
    const registration = {
      id: 'plugin:samples.midnight/midnight',
      revision: 'r1',
      pluginKey: 'samples.midnight',
      pluginName: 'Midnight',
      label: 'Midnight',
      base: 'dark',
      tokens: { '--background': '#000000', '--foreground': '#ffffff' }
    }
    expect(isPluginThemeRegistration(registration)).toBe(true)
    expect(isPluginThemeRegistration({ ...registration, id: 'midnight' })).toBe(false)
    expect(isPluginThemeRegistration({ ...registration, tokens: { '--x': '#000' } })).toBe(false)
  })
})

describe('plugin terminal theme artifacts', () => {
  const terminal = { background: '#000000', foreground: '#ffffff', green: '#00ff00' }

  it('skips unknown slots at runtime', () => {
    expect(
      parsePluginTerminalThemeArtifact(
        JSON.stringify({ schemaVersion: 1, terminal: { ...terminal, glow: '#000000' } })
      )
    ).toEqual({ mode: 'unknown', terminal })
  })

  it('normalizes a usable palette', () => {
    expect(
      parsePluginTerminalThemeArtifact(JSON.stringify({ schemaVersion: 1, terminal }))
    ).toEqual({ mode: 'unknown', terminal })
  })

  it.each([
    ['an unknown slot', { ...terminal, glow: '#000000' }],
    ['an invalid color', { ...terminal, red: 'red; x' }],
    ['no ANSI color', { background: '#000000', foreground: '#ffffff' }]
  ])('rejects %s', (_label, colors) => {
    expect(() =>
      parsePluginTerminalThemeArtifact(
        JSON.stringify({ schemaVersion: 1, terminal: colors }),
        'strict'
      )
    ).toThrow()
  })

  it('skips unknown tokens and keys at runtime so newer themes still load', () => {
    const theme = parsePluginAppThemeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        base: 'dark',
        tokens: { '--background': '#000', '--foreground': '#fff', '--future': '#123' },
        future: true
      })
    )
    expect(theme.tokens).not.toHaveProperty('--future')
    expect(parseApp({ schemaVersion: 2, base: 'dark', tokens: {} })).toThrow()
  })

  it('validates registrations crossing IPC', () => {
    const registration = {
      id: 'plugin:samples.midnight/midnight',
      pluginKey: 'samples.midnight',
      pluginName: 'Midnight',
      label: 'Midnight',
      mode: 'dark',
      terminal
    }
    expect(isPluginTerminalThemeRegistration(registration)).toBe(true)
    expect(isPluginTerminalThemeRegistration({ ...registration, terminal: {} })).toBe(false)
  })
})

describe('plugin app theme completion', () => {
  it('requires a background and foreground', () => {
    expect(parseApp({ base: 'dark', tokens: { '--background': '#000' } })).toThrow('--foreground')
  })

  it.each(['transparent', 'inherit', 'currentColor', '100px', 'calc(1px + 2px)', 'env(x)'])(
    'rejects the non-color value %s',
    (value) => {
      expect(
        parseApp({ base: 'dark', tokens: { '--background': value, '--foreground': '#fff' } })
      ).toThrow()
    }
  )

  it('derives omitted surfaces and accents from the tokens a theme sets', () => {
    const { tokens } = parsePluginAppThemeArtifact(
      JSON.stringify({
        base: 'dark',
        tokens: { '--background': '#101018', '--foreground': '#f0f0ff', '--accent': '#2a2050' }
      })
    )
    expect(tokens).toMatchObject({
      '--card': '#101018',
      '--sidebar': 'color-mix(in srgb, #f0f0ff 8%, #101018)',
      '--worktree-sidebar': 'color-mix(in srgb, #f0f0ff 8%, #101018)',
      '--sidebar-accent': '#2a2050',
      '--worktree-sidebar-accent': '#2a2050',
      '--primary': '#f0f0ff',
      '--primary-foreground': '#101018'
    })
  })

  it('keeps a sidebar the theme sets', () => {
    const { tokens } = parsePluginAppThemeArtifact(
      JSON.stringify({
        base: 'dark',
        tokens: { '--background': '#1d1533', '--foreground': '#e8e0ff', '--sidebar': '#271d45' }
      })
    )
    expect(tokens['--worktree-sidebar']).toBe('#271d45')
  })
})
