import { describe, expect, it } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { buildAppFontFamily } from '@/lib/app-font-family'
import { resolveConfiguredTerminalColors } from '../../../../shared/terminal-theme-selection'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

const makeSettings = createGlobalSettingsFixture

describe('nativeChatAppearanceStyle terminal interface', () => {
  it('uses a custom chat family while preserving code fonts and terminal matching precedence', () => {
    const settings = makeSettings({
      appFontFamily: 'Arial',
      terminalFontFamily: 'Menlo',
      nativeChatAppearance: { fontFamily: 'Georgia' }
    })
    const style = nativeChatAppearanceStyle(settings)
    expect(style['--chat-font-family']).toBe(buildAppFontFamily('Georgia'))
    expect(style['--chat-code-font-family']).toBe(buildFontFamily('Menlo'))
    expect(
      nativeChatAppearanceStyle({
        ...settings,
        nativeChatAppearance: { ...settings.nativeChatAppearance, matchTerminalInterface: true }
      })['--chat-font-family']
    ).toBe(buildFontFamily('Menlo'))
    expect(
      nativeChatAppearanceStyle({
        ...settings,
        nativeChatAppearance: { fontFamily: '' }
      })['--chat-font-family']
    ).toBeUndefined()
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
})
