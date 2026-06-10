import { describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'

vi.mock('./TerminalSettingsPreview', () => ({
  TerminalSettingsPreview: function TerminalSettingsPreview() {
    return null
  }
}))

import {
  DarkTerminalThemeSection,
  LightTerminalThemeSection,
  TerminalThemeImportSection
} from './TerminalThemeSections'

type ReactElementLike = {
  type: unknown
  props?: Record<string, unknown>
}

const warpThemesMock: UseWarpThemeImportReturn = {
  open: false,
  mode: 'warp',
  preview: null,
  loading: false,
  desktopOnly: false,
  applyError: null,
  importSignal: 0,
  selectedThemeIds: new Set<string>(),
  handleClick: vi.fn(),
  handleImportYamlClick: vi.fn(),
  handlePreviewSource: vi.fn(),
  handleToggleTheme: vi.fn(),
  handleToggleAll: vi.fn(),
  handleApply: vi.fn(),
  handleOpenChange: vi.fn()
}

function findButtonTexts(node: unknown): string[] {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return []
  }
  if (Array.isArray(node)) {
    return node.flatMap(findButtonTexts)
  }
  const element = node as ReactElementLike
  const typeName = typeof element.type === 'function' ? element.type.name : String(element.type)
  if (typeName === 'WarpThemeImportButton') {
    return ['Import themes from Warp']
  }
  if (typeName === 'YamlThemeImportButton') {
    return ['Import from YAML']
  }
  return [...findButtonTexts(element.props?.children), ...findButtonTexts(element.props?.action)]
}

function renderDarkSection(): React.JSX.Element {
  return DarkTerminalThemeSection({
    settings: {
      terminalThemeDark: 'Ghostty Default Style Dark',
      terminalDividerColorDark: '#3f3f46'
    } as GlobalSettings,
    systemPrefersDark: true,
    themeSearchDark: '',
    setThemeSearchDark: () => {},
    updateSettings: () => {},
    previewFontFamily: null,
    importedHighlightSignal: 0
  })
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

describe('TerminalThemeImportSection', () => {
  it('renders the Warp and YAML import buttons in the shared import section', () => {
    const buttonTexts = findButtonTexts(TerminalThemeImportSection({ warpThemes: warpThemesMock }))

    expect(buttonTexts).toContain('Import themes from Warp')
    expect(buttonTexts).toContain('Import from YAML')
  })

  it('keeps the import buttons out of the mode-specific theme sections', () => {
    expect(findButtonTexts(renderDarkSection())).toEqual([])
  })
})
