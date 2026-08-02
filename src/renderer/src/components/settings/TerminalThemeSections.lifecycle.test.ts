import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/types'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'

let themeTarget: 'dark' | 'light' | undefined = 'dark'

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) => {
      const initialValue = typeof initial === 'function' ? (initial as () => T)() : initial
      return [
        themeTarget ?? initialValue,
        (value: T) => {
          themeTarget = value as 'dark' | 'light'
        }
      ]
    }
  }
})

vi.mock('./TerminalSettingsPreview', () => ({
  TerminalSettingsPreview: function TerminalSettingsPreview() {
    return null
  }
}))

import {
  resetTerminalThemeTargetMemoryForTests,
  TerminalThemeCatalogSection
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

function makeSettings(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return {
    theme: 'system',
    terminalUseSeparateLightTheme: false,
    terminalThemeDark: 'Ghostty Default Style Dark',
    terminalThemeLight: 'Builtin Tango Light',
    terminalDividerColorDark: '#3f3f46',
    terminalDividerColorLight: '#d4d4d8',
    terminalCustomThemes: [],
    ...overrides
  } as GlobalSettings
}

function renderCatalog(
  settings = makeSettings(),
  updateSettings = vi.fn(),
  target?: 'dark' | 'light',
  preferredTarget?: 'dark' | 'light',
  systemPrefersDark = true
): React.JSX.Element {
  themeTarget = target
  return TerminalThemeCatalogSection({
    settings,
    systemPrefersDark,
    themeSearch: '',
    setThemeSearch: () => {},
    updateSettings,
    previewFontFamily: null,
    importedHighlightSignal: 7,
    warpThemes: warpThemesMock,
    showThemeImport: true,
    preferredTarget
  })
}

function getTypeName(node: ReactElementLike): string {
  return typeof node.type === 'function' ? node.type.name : String(node.type)
}

function countElementsByTypeName(node: unknown, typeName: string): number {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return 0
  }
  if (Array.isArray(node)) {
    return node.reduce((total, child) => total + countElementsByTypeName(child, typeName), 0)
  }

  const element = node as ReactElementLike
  const childCount = countElementsByTypeName(element.props?.children, typeName)
  return getTypeName(element) === typeName ? childCount + 1 : childCount
}

function findElementByTypeName(node: unknown, typeName: string): ReactElementLike | null {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByTypeName(child, typeName)
      if (found) {
        return found
      }
    }
    return null
  }

  const element = node as ReactElementLike
  if (getTypeName(element) === typeName) {
    return element
  }
  return findElementByTypeName(element.props?.children, typeName)
}

function findElementByClassSubstring(
  node: unknown,
  classNameSubstring: string
): ReactElementLike | null {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return null
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementByClassSubstring(child, classNameSubstring)
      if (found) {
        return found
      }
    }
    return null
  }

  const element = node as ReactElementLike
  if (
    typeof element.props?.className === 'string' &&
    element.props.className.includes(classNameSubstring)
  ) {
    return element
  }
  return findElementByClassSubstring(element.props?.children, classNameSubstring)
}

function findButtonTexts(node: unknown): string[] {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return []
  }
  if (Array.isArray(node)) {
    return node.flatMap(findButtonTexts)
  }
  const element = node as ReactElementLike
  const typeName = getTypeName(element)
  if (typeName === 'WarpThemeImportButton') {
    return ['Import from Warp']
  }
  if (typeName === 'YamlThemeImportButton') {
    return ['Import from YAML']
  }
  return [...findButtonTexts(element.props?.children), ...findButtonTexts(element.props?.action)]
}

describe('TerminalThemeCatalogSection', () => {
  beforeEach(() => {
    themeTarget = 'dark'
    resetTerminalThemeTargetMemoryForTests()
    vi.clearAllMocks()
  })

  it('renders one theme picker and one preview for the active target', () => {
    const element = renderCatalog(makeSettings({ terminalUseSeparateLightTheme: false }), vi.fn())

    expect(countElementsByTypeName(element, 'ThemePicker')).toBe(1)
    expect(countElementsByTypeName(element, 'TerminalSettingsPreview')).toBe(1)
    expect(findElementByTypeName(element, 'TerminalSettingsPreview')?.props?.modeOverride).toBe(
      'dark'
    )
  })

  it('opens on the active light theme when the system appearance is light', () => {
    const updateSettings = vi.fn()
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      updateSettings,
      undefined,
      undefined,
      false
    )
    const picker = findElementByTypeName(element, 'ThemePicker')
    const preview = findElementByTypeName(element, 'TerminalSettingsPreview')
    const selectTheme = picker?.props?.onSelectTheme as (theme: string) => void

    expect(picker?.props?.selectedTheme).toBe('Builtin Tango Light')
    expect(preview?.props?.modeOverride).toBe('light')

    selectTheme('GitHub Light')

    expect(updateSettings).toHaveBeenCalledWith({ terminalThemeLight: 'GitHub Light' })
  })

  it('reopens the manually edited light target while the active appearance is dark', () => {
    const firstOpen = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      vi.fn(),
      undefined,
      undefined,
      true
    )
    const targetControl = findElementByTypeName(firstOpen, 'SettingsSegmentedControl')
    const selectTarget = targetControl?.props?.onChange as (target: 'dark' | 'light') => void

    selectTarget('light')

    const reopened = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      vi.fn(),
      undefined,
      undefined,
      true
    )
    const picker = findElementByTypeName(reopened, 'ThemePicker')
    const preview = findElementByTypeName(reopened, 'TerminalSettingsPreview')

    expect(picker?.props?.selectedTheme).toBe('Builtin Tango Light')
    expect(preview?.props?.modeOverride).toBe('light')
  })

  it('opens a customized light-only theme after reload even when the active appearance is dark', () => {
    const element = renderCatalog(
      makeSettings({
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'GitHub Light'
      }),
      vi.fn(),
      undefined,
      undefined,
      true
    )
    const picker = findElementByTypeName(element, 'ThemePicker')
    const preview = findElementByTypeName(element, 'TerminalSettingsPreview')

    expect(picker?.props?.selectedTheme).toBe('GitHub Light')
    expect(preview?.props?.modeOverride).toBe('light')
  })

  it('keeps the light target enabled while separate light theme is disabled', () => {
    const element = renderCatalog(makeSettings({ terminalUseSeparateLightTheme: false }), vi.fn())
    const targetControl = findElementByTypeName(element, 'SettingsSegmentedControl')
    const options = targetControl?.props?.options as readonly {
      value: string
      disabled?: boolean
    }[]

    expect(options.find((option) => option.value === 'light')?.disabled).toBeUndefined()
  })

  it('uses the preferred target when opened from a light-specific search', () => {
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      vi.fn(),
      undefined,
      'light'
    )
    const picker = findElementByTypeName(element, 'ThemePicker')
    const preview = findElementByTypeName(element, 'TerminalSettingsPreview')

    expect(picker?.props?.selectedTheme).toBe('Builtin Tango Light')
    expect(preview?.props?.modeOverride).toBe('light')
  })

  it('updates the dark theme from the catalog when the dark target is active', () => {
    const updateSettings = vi.fn()
    const element = renderCatalog(makeSettings(), updateSettings, 'dark')
    const picker = findElementByTypeName(element, 'ThemePicker')
    const selectTheme = picker?.props?.onSelectTheme as (theme: string) => void

    selectTheme('Builtin Solarized Dark')

    expect(updateSettings).toHaveBeenCalledWith({ terminalThemeDark: 'Builtin Solarized Dark' })
  })

  it('updates the light theme from the catalog when the light target is active', () => {
    const updateSettings = vi.fn()
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      updateSettings,
      'light'
    )
    const picker = findElementByTypeName(element, 'ThemePicker')
    const selectTheme = picker?.props?.onSelectTheme as (theme: string) => void

    selectTheme('Builtin Tango Light')

    expect(updateSettings).toHaveBeenCalledWith({ terminalThemeLight: 'Builtin Tango Light' })
  })

  it('turns match dark mode off to customize light mode', () => {
    const updateSettings = vi.fn()
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: false }),
      updateSettings,
      'light'
    )
    const matchDarkModeSwitch = findElementByTypeName(element, 'SettingsSwitchRow')
    const toggleMatchDarkMode = matchDarkModeSwitch?.props?.onChange as () => void

    expect(matchDarkModeSwitch?.props?.label).toBe('Match dark mode')
    expect(matchDarkModeSwitch?.props?.description).toBe(
      'Share the dark terminal theme and divider color in light mode.'
    )
    expect(matchDarkModeSwitch?.props?.checked).toBe(true)

    toggleMatchDarkMode()

    expect(updateSettings).toHaveBeenCalledWith({ terminalUseSeparateLightTheme: true })
  })

  it('turns match dark mode on from the customized light state', () => {
    const updateSettings = vi.fn()
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      updateSettings,
      'light'
    )
    const matchDarkModeSwitch = findElementByTypeName(element, 'SettingsSwitchRow')
    const toggleMatchDarkMode = matchDarkModeSwitch?.props?.onChange as () => void

    expect(matchDarkModeSwitch?.props?.checked).toBe(false)

    toggleMatchDarkMode()

    expect(updateSettings).toHaveBeenCalledWith({ terminalUseSeparateLightTheme: false })
  })

  it('collapses light customization with a transition while matching dark mode', () => {
    const element = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: false }),
      vi.fn(),
      'light'
    )
    const preview = findElementByTypeName(element, 'TerminalSettingsPreview')
    const matchDarkModeSwitch = findElementByTypeName(element, 'SettingsSwitchRow')
    const transitionRegion = findElementByClassSubstring(
      element,
      'transition-[grid-template-rows,padding-top]'
    )

    expect(matchDarkModeSwitch?.props?.label).toBe('Match dark mode')
    expect(transitionRegion?.props?.className).toContain('grid-rows-[0fr]')
    expect(transitionRegion?.props?.['aria-hidden']).toBe(true)
    expect(transitionRegion?.props?.inert).toBe(true)
    expect(countElementsByTypeName(element, 'ThemePicker')).toBe(1)
    expect(countElementsByTypeName(element, 'ColorField')).toBe(1)
    expect(preview?.props?.modeOverride).toBe('light')
  })

  it('uses the active target for divider color updates', () => {
    const updateSettings = vi.fn()
    const lightElement = renderCatalog(
      makeSettings({ terminalUseSeparateLightTheme: true }),
      updateSettings,
      'light'
    )
    const lightColorField = findElementByTypeName(lightElement, 'ColorField')
    const updateLightDividerColor = lightColorField?.props?.onChange as (value: string) => void

    updateLightDividerColor('#ffffff')

    expect(updateSettings).toHaveBeenCalledWith({ terminalDividerColorLight: '#ffffff' })

    updateSettings.mockClear()
    const darkElement = renderCatalog(makeSettings(), updateSettings, 'dark')
    const darkColorField = findElementByTypeName(darkElement, 'ColorField')
    const updateDarkDividerColor = darkColorField?.props?.onChange as (value: string) => void

    updateDarkDividerColor('#000000')

    expect(updateSettings).toHaveBeenCalledWith({ terminalDividerColorDark: '#000000' })
  })

  it('passes imported theme highlight signals into the shared picker', () => {
    const element = renderCatalog()
    const picker = findElementByTypeName(element, 'ThemePicker')

    expect(picker?.props?.importedHighlightSignal).toBe(7)
  })
})

describe('Terminal theme imports', () => {
  it('renders the Warp and YAML import buttons inside the combined theme catalog', () => {
    const buttonTexts = findButtonTexts(renderCatalog())

    expect(buttonTexts).toEqual(['Import from Warp', 'Import from YAML'])
  })
})
