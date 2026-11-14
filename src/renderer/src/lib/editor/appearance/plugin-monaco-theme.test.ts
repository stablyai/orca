import { expect, it } from 'vitest'
import type { ColorProbe } from '../../../app-shell/appearance/plugin-theme-tokens'
import { derivePluginMonacoTheme } from './plugin-monaco-theme'

const probe: ColorProbe = (value) => {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(value.trim())
  if (!hex) {
    return null
  }
  const channel = (offset: number): number => Number.parseInt(hex[1].slice(offset, offset + 2), 16)
  return [channel(0), channel(2), channel(4), hex[2] ? Number.parseInt(hex[2], 16) / 255 : 1]
}

it('paints a theme-chosen editor selection instead of the ring', () => {
  const tokens: Record<string, string> = {
    '--background': '#261d45',
    '--foreground': '#ffffff',
    '--ring': '#00ff6a',
    '--editor-selection': '#ff2a6d66'
  }
  const theme = derivePluginMonacoTheme({
    base: 'dark',
    read: (token) => tokens[token] ?? '',
    painted: tokens,
    probe
  })
  expect(theme?.data.colors['editor.selectionBackground']).toBe('#ff2a6d66')
  expect(theme?.data.colors['editor.inactiveSelectionBackground']).toBe('#ff2a6d33')
})
