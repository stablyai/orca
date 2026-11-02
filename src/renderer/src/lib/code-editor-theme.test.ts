import { describe, expect, it } from 'vitest'
import type { PluginThemeRegistration } from '../../../shared/plugins/artifacts/plugin-theme-artifact'
import { paintCodeEditorColors, resolveCodeEditorTheme } from './code-editor-theme'
import type { ColorProbe } from './plugin-theme-tokens'

// Parses #rrggbb, which is all these tests feed it.
const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1]
  if (!hex) {
    return null
  }
  const channel = (offset: number): number => Number.parseInt(hex.slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4), 1]
}

function theme(
  id: string,
  base: 'light' | 'dark',
  tokens: Record<string, string>
): PluginThemeRegistration {
  return {
    id: `plugin:samples.themes/${id}`,
    base,
    tokens,
    revision: '1',
    pluginKey: 'samples.themes',
    pluginName: 'Samples',
    label: id
  }
}

const dusk = theme('dusk', 'dark', {
  '--background': '#1b1430',
  '--editor-surface': '#120d22',
  '--foreground': '#e8e0ff',
  '--muted-foreground': '#b9add6',
  '--border': '#5b3f9c'
})
const dawn = theme('dawn', 'light', { '--background': '#fdf6e3', '--foreground': '#3b3226' })
const murk = theme('murk', 'dark', { '--background': '#202020', '--foreground': '#303030' })

function resolve(
  selected: Parameters<typeof resolveCodeEditorTheme>[0]['selected'],
  appTheme: PluginThemeRegistration | null = null
) {
  return resolveCodeEditorTheme({
    dark: false,
    appTheme,
    selected,
    appPainted: appTheme?.tokens ?? {},
    readDocument: (token) => dawn.tokens[token] ?? '',
    probe
  })
}

describe('resolveCodeEditorTheme', () => {
  it('follows the painted app theme when nothing or the app theme itself is chosen', () => {
    expect(resolve(null)).toEqual({ monaco: null, override: null })
    expect(resolve('light')).toEqual({ monaco: null, override: null })
    const followed = resolve(dawn, dawn)
    expect(followed.override).toBeNull()
    expect(followed.monaco?.data.colors['editor.background']).toBe('#fdf6e3')
  })

  it("paints a dark plugin editor in a light app from that theme's own tokens", () => {
    const result = resolve(dusk, dawn)
    expect(result.monaco?.data.base).toBe('vs-dark')
    expect(result.override).toEqual({
      base: 'dark',
      colors: {
        background: '#120d22',
        foreground: '#e8e0ff',
        mutedForeground: '#b9add6',
        border: '#5b3f9c'
      }
    })
  })

  it("uses Monaco's built-in colors for a built-in choice or an unreadable theme", () => {
    expect(resolve('dark')).toMatchObject({ monaco: null, override: { base: 'dark' } })
    // A built-in light editor still overrides a plugin app theme of the same mode.
    expect(resolve('light', dawn)).toMatchObject({ monaco: null, override: { base: 'light' } })
    // An unreadable caret drops to the theme's foreground, as for an app theme.
    const hidden = resolve(
      theme('ink', 'dark', {
        '--background': '#000000',
        '--editor-surface': '#000000',
        '--foreground': '#ffffff',
        '--muted-foreground': '#aaaaaa',
        '--ring': '#000000'
      })
    )
    expect(hidden.monaco?.data.colors['editorCursor.foreground']).toBe('#ffffff')
    expect(resolve(murk)).toMatchObject({
      monaco: null,
      override: { base: 'dark', colors: { background: '#1e1e1e' } }
    })
  })
})

describe('paintCodeEditorColors', () => {
  it('publishes an override on the root and clears it when the editor follows the app', () => {
    const properties = new Map<string, string>()
    const dataset: DOMStringMap = {}
    const root = {
      dataset,
      style: {
        setProperty: (name: string, value: string | null) => {
          properties.set(name, value ?? '')
        },
        removeProperty: (name: string) => {
          properties.delete(name)
          return ''
        }
      }
    }
    paintCodeEditorColors(resolve(dusk, dawn).override, root)
    expect(dataset.codeEditorTheme).toBe('dark')
    expect(properties.get('--code-editor-background')).toBe('#120d22')
    paintCodeEditorColors(null, root)
    expect(dataset.codeEditorTheme).toBeUndefined()
    expect(properties.size).toBe(0)
  })
})
