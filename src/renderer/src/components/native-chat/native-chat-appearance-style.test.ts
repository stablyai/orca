import { describe, expect, it } from 'vitest'
import { nativeChatAppearanceStyle } from './native-chat-appearance-style'

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
