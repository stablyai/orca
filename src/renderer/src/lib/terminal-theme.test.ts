import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getBuiltinTheme
} from './terminal-theme'

// Mirrors Codex instruction block gray so the dark selection cannot disappear into it.
const INSTRUCTION_BLOCK_BACKGROUND = '#3e4451'

function parseHexColor(color: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  const hex = match?.[1]
  if (!hex) {
    return null
  }

  const value = Number.parseInt(hex, 16)
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255]
}

function toLinearChannel(channel: number): number {
  const scaled = channel / 255
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  return (
    0.2126 * toLinearChannel(red) + 0.7152 * toLinearChannel(green) + 0.0722 * toLinearChannel(blue)
  )
}

function contrastRatio(first: string, second: string): number {
  const firstRgb = parseHexColor(first)
  const secondRgb = parseHexColor(second)

  expect(firstRgb, `${first} should be a 6-digit hex color`).not.toBeNull()
  expect(secondRgb, `${second} should be a 6-digit hex color`).not.toBeNull()
  if (!firstRgb || !secondRgb) {
    throw new Error('Expected contrast colors to parse as 6-digit hex values')
  }

  const firstLuminance = relativeLuminance(firstRgb)
  const secondLuminance = relativeLuminance(secondRgb)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('default dark terminal theme selection contrast', () => {
  it('keeps selection distinct from instruction blocks while preserving readable selected text', () => {
    const theme = getBuiltinTheme(DEFAULT_TERMINAL_THEME_DARK)

    expect(theme, `${DEFAULT_TERMINAL_THEME_DARK} should exist`).not.toBeNull()

    const selectionBackground = theme?.selectionBackground
    const selectionForeground = theme?.selectionForeground

    expect(selectionBackground, 'selectionBackground should be defined').toBeDefined()
    expect(selectionForeground, 'selectionForeground should be defined').toBeDefined()
    if (!selectionBackground || !selectionForeground) {
      throw new Error(`${DEFAULT_TERMINAL_THEME_DARK} is missing selection colors`)
    }

    expect(contrastRatio(selectionBackground, INSTRUCTION_BLOCK_BACKGROUND)).toBeGreaterThanOrEqual(
      2
    )
    expect(contrastRatio(selectionForeground, selectionBackground)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('default light terminal theme ANSI contrast', () => {
  it('keeps CLI body/header ANSI colors readable on the terminal background', () => {
    const theme = getBuiltinTheme(DEFAULT_TERMINAL_THEME_LIGHT)

    expect(theme, `${DEFAULT_TERMINAL_THEME_LIGHT} should exist`).not.toBeNull()
    if (!theme?.background) {
      throw new Error(`${DEFAULT_TERMINAL_THEME_LIGHT} is missing a background color`)
    }

    for (const key of ['cyan', 'white', 'brightCyan', 'brightWhite'] as const) {
      const color = theme[key]
      expect(color, `${DEFAULT_TERMINAL_THEME_LIGHT}.${key} should be defined`).toBeDefined()
      if (!color) {
        throw new Error(`${DEFAULT_TERMINAL_THEME_LIGHT}.${key} is missing`)
      }
      expect(contrastRatio(color, theme.background)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
