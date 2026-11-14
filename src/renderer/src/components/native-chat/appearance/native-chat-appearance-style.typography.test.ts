// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

const SYSTEM_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'

function styleFor(settings: Partial<GlobalSettings>) {
  return nativeChatAppearanceStyle({ theme: 'dark', ...settings }, null, true)
}

describe('native chat typography', () => {
  it('rounds the line height to whole pixels at every Text size', () => {
    const lines = [12, 13, 14, 16, 18, 20].map(
      (fontSize) => styleFor({ nativeChatAppearance: { fontSize } })['--chat-line-height']
    )
    expect(lines).toEqual(['18px', '20px', '22px', '25px', '28px', '31px'])
  })

  it('keeps labels, icons and spacing at their earlier size: 14px at the default, Text size elsewhere', () => {
    const chrome = [12, 13, 14, 16, 20].map(
      (fontSize) => styleFor({ nativeChatAppearance: { fontSize } })['--chat-ui-font-size']
    )
    expect(chrome).toEqual(['12px', '14px', '14px', '16px', '20px'])
  })

  it('uses the system UI font only while neither the chat nor the IDE font was chosen', () => {
    expect(styleFor({ appFontFamily: 'Geist' })['--chat-font-family']).toBe(SYSTEM_FONT)
    expect(styleFor({})['--chat-font-family']).toBe(SYSTEM_FONT)
    expect(
      styleFor({ appFontFamily: 'Geist', nativeChatAppearance: { fontFamily: 'Georgia' } })[
        '--chat-font-family'
      ]
    ).toMatch(/^"Georgia", /)
    // Absent: the root falls back to the IDE font.
    expect(styleFor({ appFontFamily: 'Inter' })['--chat-font-family']).toBeUndefined()
    expect(
      styleFor({
        appFontFamily: 'Geist',
        terminalFontFamily: 'JetBrains Mono',
        nativeChatAppearance: { matchTerminalInterface: true }
      })['--chat-font-family']
    ).toMatch(/JetBrains Mono/)
  })

  it('keeps the brighter text color 10 points above body text, up to full strength', () => {
    const mixes = (theme: 'dark' | 'light', contrast: number) => {
      const style = styleFor({ theme, nativeChatAppearance: { contrast } })
      return [style['--chat-foreground-mix'], style['--chat-strong-mix']]
    }
    expect(mixes('dark', 75)).toEqual(['72%', '82%'])
    expect(mixes('light', 75)).toEqual(['76%', '86%'])
    expect(mixes('dark', 150)).toEqual(['100%', '100%'])
  })

  it('scales body text with Contrast, keeping the earlier ends', () => {
    const mixes = (theme: 'dark' | 'light') =>
      [50, 75, 100, 125, 150].map(
        (contrast) =>
          styleFor({ theme, nativeChatAppearance: { contrast } })['--chat-foreground-mix']
      )
    expect(mixes('dark')).toEqual(['56%', '72%', '88%', '94%', '100%'])
    expect(mixes('light')).toEqual(['64%', '76%', '88%', '94%', '100%'])
  })
})
