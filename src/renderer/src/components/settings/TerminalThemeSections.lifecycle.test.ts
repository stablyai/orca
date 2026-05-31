import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'

vi.mock('./TerminalSettingsPreview', () => ({
  TerminalSettingsPreview: function TerminalSettingsPreview() {
    return null
  }
}))

import { LightTerminalThemeSection } from './TerminalThemeSections'

type ReactElementLike = {
  type: unknown
  props?: Record<string, unknown>
}

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    terminalUseSeparateLightTheme: false,
    terminalThemeLight: 'Builtin Tango Light',
    terminalDividerColorLight: '#d4d4d8',
    ...overrides
  } as GlobalSettings
}

function countElementsByTypeName(node: unknown, typeName: string): number {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return 0
  }
  if (Array.isArray(node)) {
    return node.reduce((total, child) => total + countElementsByTypeName(child, typeName), 0)
  }

  const element = node as ReactElementLike
  const currentTypeName =
    typeof element.type === 'function' ? element.type.name : String(element.type)
  const childCount = countElementsByTypeName(element.props?.children, typeName)
  return currentTypeName === typeName ? childCount + 1 : childCount
}

function renderLightSection(settings: GlobalSettings): React.JSX.Element {
  return LightTerminalThemeSection({
    settings,
    themeSearchLight: '',
    setThemeSearchLight: () => {},
    updateSettings: () => {},
    previewFontFamily: null
  })
}

describe('LightTerminalThemeSection preview lifecycle', () => {
  it('does not mount the terminal preview while separate light theme is disabled', () => {
    const element = renderLightSection(makeSettings({ terminalUseSeparateLightTheme: false }))

    expect(countElementsByTypeName(element, 'TerminalSettingsPreview')).toBe(0)
  })

  it('mounts the terminal preview when separate light theme is enabled', () => {
    const element = renderLightSection(makeSettings({ terminalUseSeparateLightTheme: true }))

    expect(countElementsByTypeName(element, 'TerminalSettingsPreview')).toBe(1)
  })
})
