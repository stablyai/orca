import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { buildFontFamily } from '@/lib/monospace-font-family'
import * as terminalThemeSelection from '../../../../shared/terminal-theme-selection'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { nativeChatAppearanceStyle, nativeChatContrastMix } from './native-chat-appearance-style'

const makeSettings = createGlobalSettingsFixture
afterEach(() => vi.restoreAllMocks())

describe('nativeChatContrastMix', () => {
  it.each([
    [50, false, 56],
    [100, false, 78],
    [150, false, 100],
    [50, true, 64],
    [100, true, 82],
    [150, true, 100],
    [-100, false, 56],
    [200, true, 100],
    [Number.NaN, false, 78]
  ])('maps %s in light mode %s to %s', (contrast, light, expected) => {
    expect(nativeChatContrastMix(contrast, light)).toBe(expected)
  })
})

describe('nativeChatAppearanceStyle terminal interface', () => {
  it('follows the terminal code font while keeping default body font and colors', () => {
    const style = nativeChatAppearanceStyle(makeSettings({ terminalFontFamily: 'Menlo' }))
    expect(style['--chat-code-font-family']).toBe(buildFontFamily('Menlo'))
    expect(style['--chat-font-family']).toBeUndefined()
    expect(style['--chat-source-foreground']).toBeUndefined()
    expect(style['--chat-source-background']).toBeUndefined()
    expect(style['--chat-foreground-mix']).toBe('78%')
  })

  it('updates the code font and matching body font from the current terminal setting', () => {
    for (const terminalFontFamily of ['', 'Menlo', 'Consolas']) {
      const settings = makeSettings({
        terminalFontFamily,
        nativeChatAppearance: { matchTerminalInterface: true }
      })
      const style = nativeChatAppearanceStyle(settings)
      expect(style['--chat-font-family']).toBe(buildFontFamily(terminalFontFamily))
      expect(style['--chat-code-font-family']).toBe(buildFontFamily(terminalFontFamily))
      expect(style['--chat-code-font-size']).toBe(`${settings.terminalFontSize}px`)
    }
  })

  it('uses the selected theme and live overrides as the two palette sources', () => {
    const settings = makeSettings({
      nativeChatAppearance: { matchTerminalInterface: true, contrast: 150 },
      terminalColorOverrides: { background: '#122033', foreground: '#ddeeff' }
    })
    const style = nativeChatAppearanceStyle(settings)
    expect(style['--chat-source-background']).toBe('#122033')
    expect(style['--chat-source-foreground']).toBe('#ddeeff')
    expect(style['--chat-canvas-mix']).toBe('0%')
    expect(style['--chat-foreground-mix']).toBe('100%')
    expect(style['--chat-code-base']).toBe('transparent')
  })

  it('resolves custom themes and falls back when the selected theme was removed', () => {
    const settings = makeSettings({
      terminalThemeDark: 'custom:manual:sample',
      terminalCustomThemes: [
        {
          id: 'manual:sample',
          name: 'Sample',
          source: 'manual',
          mode: 'dark',
          terminal: { background: '#122033', foreground: '#ddeeff', black: '#000001' },
          importedAt: '2026-10-05T00:00:00.000Z'
        }
      ],
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    expect(nativeChatAppearanceStyle(settings)['--chat-source-background']).toBe('#122033')
    const missing = { ...settings, terminalCustomThemes: [] }
    expect(nativeChatAppearanceStyle(missing)['--chat-source-background']).toBe(
      resolveConfiguredTerminalColors(missing, true).background
    )
  })

  it('uses light formulas for a light terminal inside a dark app', () => {
    const settings = makeSettings({
      theme: 'dark',
      terminalThemeDark: 'Builtin Tango Light',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const style = nativeChatAppearanceStyle(settings)
    const colors = resolveConfiguredTerminalColors(settings, true)
    expect(style['--chat-source-background']).toBe(colors.background)
    expect(style['--chat-source-foreground']).toBe(colors.foreground)
    expect(style['--chat-foreground-mix']).toBe('100%')
    expect(style['--chat-code-base']).toBe('var(--chat-canvas)')
    expect(style['--chat-strong-mix']).toBe('100%')
  })

  it('follows the separate light theme and system theme changes', () => {
    const settings = makeSettings({
      theme: 'system',
      terminalUseSeparateLightTheme: true,
      terminalThemeLight: 'Builtin Tango Light',
      nativeChatAppearance: { matchTerminalInterface: true }
    })
    const dark = nativeChatAppearanceStyle(settings, undefined, true)
    const light = nativeChatAppearanceStyle(settings, undefined, false)
    expect(light['--chat-source-background']).toBe(
      resolveConfiguredTerminalColors(settings, false).background
    )
    expect(light['--chat-source-background']).not.toBe(dark['--chat-source-background'])
    expect(light['--chat-foreground-mix']).toBe('100%')
  })

  it('uses app light contrast without matching and removes matching overrides when off', () => {
    const style = nativeChatAppearanceStyle(
      makeSettings({
        theme: 'light',
        nativeChatAppearance: { matchTerminalInterface: false, contrast: 50 }
      })
    )
    expect(style['--chat-foreground-mix']).toBe('64%')
    expect(style['--chat-font-family']).toBeUndefined()
    expect(style['--chat-canvas-mix']).toBeUndefined()
  })

  it('uses live terminal size and full foreground while matching, then restores saved chat sizes and contrast', () => {
    const settings = makeSettings({
      terminalFontSize: 17,
      nativeChatAppearance: {
        fontSize: 20,
        codeFontSize: 10,
        contrast: 50,
        matchTerminalInterface: true
      }
    })
    const matched = nativeChatAppearanceStyle(settings, 384)
    expect(matched).toMatchObject({
      '--chat-font-size': '17px',
      '--chat-code-font-size': '17px',
      '--chat-inline-code-ratio': '1em',
      '--chat-foreground-mix': '100%',
      '--chat-estimated-line-height': (22 * 17) / 14
    })
    expect(
      nativeChatAppearanceStyle({ ...settings, terminalFontSize: 18 })['--chat-font-size']
    ).toBe('18px')
    const restored = nativeChatAppearanceStyle({
      ...settings,
      nativeChatAppearance: { ...settings.nativeChatAppearance, matchTerminalInterface: false }
    })
    expect(restored).toMatchObject({
      '--chat-font-size': '20px',
      '--chat-code-font-size': '10px',
      '--chat-foreground-mix': '56%'
    })
  })
})

describe('chat root appearance style', () => {
  it('keeps shared typography tokens independent of chat size and provides a relative code ratio', () => {
    const style = nativeChatAppearanceStyle({
      nativeChatAppearance: { fontSize: 20, codeFontSize: 12 }
    })
    expect(style).not.toHaveProperty('--text-sm')
    expect(style).not.toHaveProperty('--text-xs')
    expect(style).not.toHaveProperty('fontSize')
    expect(style['--chat-inline-code-ratio']).toBe('0.6em')
  })
  it('derives wrap capacity from actual column width, including full-width panes', () => {
    const wide = nativeChatAppearanceStyle({ nativeChatAppearance: { width: 'wide' } })
    const full = nativeChatAppearanceStyle({ nativeChatAppearance: { width: 'full' } }, 1200)
    expect(wide['--chat-estimated-chars-per-line']).toBeGreaterThan(96)
    expect(full['--chat-estimated-chars-per-line']).toBeGreaterThan(
      wide['--chat-estimated-chars-per-line']
    )
    expect(nativeChatAppearanceStyle(undefined, 384)['--chat-estimated-chars-per-line']).toBe(50)
  })

  it('provides default text, independent code size, and comfortable width', () => {
    expect(nativeChatAppearanceStyle(undefined)).toMatchObject({
      '--chat-font-size': '14px',
      '--chat-code-font-size': '12px',
      '--chat-content-max-width': '46rem',
      '--chat-estimated-line-height': 22,
      '--chat-estimated-chars-per-line': 96
    })
  })
  it.each(['light', 'dark', 'system'] as const)(
    'leaves native controls app-owned in %s mode when matching is off',
    (theme) => {
      for (const nativeChatAppearance of [
        undefined,
        { matchTerminalInterface: false },
        { contrast: 150 }
      ]) {
        const style = nativeChatAppearanceStyle(makeSettings({ theme, nativeChatAppearance }))
        expect(style.colorScheme).toBeUndefined()
        expect(style.color).toBeUndefined()
      }
    }
  )

  it('clamps sizes on read and derives the column width', () => {
    expect(
      nativeChatAppearanceStyle({
        nativeChatAppearance: { fontSize: 25, codeFontSize: 1, width: 'wide' }
      })
    ).toMatchObject({
      '--chat-font-size': '20px',
      '--chat-code-font-size': '10px',
      '--chat-content-max-width': '60rem'
    })
    expect(
      nativeChatAppearanceStyle({ nativeChatAppearance: { width: 'full' } })[
        '--chat-content-max-width'
      ]
    ).toBe('none')
  })
})

describe('contrast hierarchy and incomplete terminal palettes', () => {
  it.each(['light', 'dark'] as const)(
    'keeps strong text above body in %s mode up to the cap',
    (theme) => {
      for (const matching of [false, true]) {
        for (let contrast = 50; contrast <= 150; contrast++) {
          const style = nativeChatAppearanceStyle(
            makeSettings({
              theme,
              terminalColorOverrides:
                theme === 'light'
                  ? { background: '#ffffff', foreground: '#000000' }
                  : { background: '#000000', foreground: '#ffffff' },
              nativeChatAppearance: { contrast, matchTerminalInterface: matching }
            })
          )
          const body = Number.parseFloat(String(style['--chat-foreground-mix']))
          const strong = Number.parseFloat(String(style['--chat-strong-mix']))
          expect(strong).toBe(Math.min(100, body + (theme === 'light' ? 10 : 12)))
          if (body < 100) {
            expect(strong).toBeGreaterThan(body)
          }
        }
      }
    }
  )

  it.each([{}, { background: '#ffffff' }, { foreground: '#000000' }])(
    'uses the fallback source pair for an incomplete palette %j',
    (colors) => {
      vi.spyOn(terminalThemeSelection, 'resolveConfiguredTerminalColors').mockReturnValue(colors)
      for (const theme of ['light', 'dark'] as const) {
        const style = nativeChatAppearanceStyle(
          makeSettings({
            theme,
            nativeChatAppearance: { matchTerminalInterface: true }
          })
        )
        expect(style['--chat-source-background']).toBe('#000000')
        expect(style['--chat-source-foreground']).toBe('#fafafa')
        expect(style.colorScheme).toBe('dark')
      }
    }
  )
})
