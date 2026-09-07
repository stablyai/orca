// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { resetRendererAppPlatformCacheForTests } from '@/lib/renderer-app-platform'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

const mocks = vi.hoisted(() => ({
  state: {
    appPlatform: 'linux' as NodeJS.Platform,
    availableStatusBarToggles: [] as {
      description: string
      id: StatusBarItem
      keywords: string[]
      title: string
      toggleDescription: string
    }[],
    settingsSearchQuery: 'automations',
    statusBarItems: [],
    toggleStatusBarItem: vi.fn(),
    usagePercentageDisplay: 'used' as 'used' | 'remaining',
    setUsagePercentageDisplay: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    setWorktreeCardMode: vi.fn(),
    appearanceAccordionDeepLink: null as 'interface' | 'terminal' | 'window' | null,
    clearAppearanceAccordionDeepLink: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyComboDetails: () => []
}))

vi.mock('../status-bar/use-available-status-bar-toggles', () => ({
  useAvailableStatusBarToggles: () => mocks.state.availableStatusBarToggles
}))

vi.mock('./TerminalAppearanceSection', () => ({
  TerminalAppearanceSection: () => null
}))

vi.mock('../ui/select', async () => {
  const React = await import('react')

  const SelectContext = React.createContext<{
    onValueChange?: (value: string) => void
  }>({})

  return {
    Select: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = React.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="language-select" data-value={value}>
            {children}
          </div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'> & { size?: string }) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = React.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

import { AppearancePane } from './AppearancePane'
import { TooltipProvider } from '../ui/tooltip'

const mountedRoots: Root[] = []

function createGhosttyStub() {
  return {
    loading: false,
    preview: null,
    error: null,
    open: vi.fn(),
    close: vi.fn(),
    refresh: vi.fn(),
    apply: vi.fn()
  }
}

function createWarpThemesStub() {
  return {
    open: false,
    preview: null,
    loading: false,
    desktopOnly: false,
    applyError: null,
    importSignal: 0,
    selectedThemeIds: new Set<string>(),
    handleClick: vi.fn(),
    handlePreviewSource: vi.fn(),
    handleToggleTheme: vi.fn(),
    handleToggleAll: vi.fn(),
    handleApply: vi.fn(),
    handleOpenChange: vi.fn()
  }
}

async function renderAppearancePane(
  settings: GlobalSettings,
  updateSettings: (updates: Partial<GlobalSettings>) => void = vi.fn(),
  options: {
    onRequestFontSuggestions?: () => void
  } = {}
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <AppearancePane
            settings={settings}
            updateSettings={updateSettings}
            applyTheme={vi.fn()}
            fontSuggestions={[]}
            terminalFontSuggestions={[]}
            onRequestFontSuggestions={options.onRequestFontSuggestions}
            systemPrefersDark={false}
            ghostty={createGhosttyStub() as never}
            warpThemes={createWarpThemesStub() as never}
          />
        </TooltipProvider>
      </I18nextProvider>
    )
  })

  return container
}

async function rerenderAppearancePane(
  settings: GlobalSettings = getDefaultSettings('/tmp')
): Promise<void> {
  const root = mountedRoots.at(-1)
  if (!root) {
    throw new Error('expected a mounted AppearancePane root')
  }
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <TooltipProvider>
          <AppearancePane
            settings={settings}
            updateSettings={vi.fn()}
            applyTheme={vi.fn()}
            fontSuggestions={[]}
            terminalFontSuggestions={[]}
            systemPrefersDark={false}
            ghostty={createGhosttyStub() as never}
            warpThemes={createWarpThemesStub() as never}
          />
        </TooltipProvider>
      </I18nextProvider>
    )
  })
}

function appearanceSectionToggle(
  container: HTMLElement,
  sectionId: 'interface' | 'terminal' | 'window'
): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).find(
    (button) => button.getAttribute('aria-controls') === `appearance-section-${sectionId}`
  )
}

describe('AppearancePane', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetRendererAppPlatformCacheForTests()
    mocks.state.availableStatusBarToggles = []
    mocks.state.appPlatform = 'linux'
    mocks.state.settingsSearchQuery = 'automations'
    mocks.state.appearanceAccordionDeepLink = null
    mocks.state.usagePercentageDisplay = 'used'
    // UIZoomControl reads window.api.ui on mount; the inline-expansion pane can
    // render the full Interface section, so provide a minimal renderer bridge
    // without clobbering happy-dom's window.location.
    ;(window as unknown as { api: unknown }).api = {
      platform: {
        get: () => ({ platform: mocks.state.appPlatform })
      },
      ui: {
        getZoomLevel: () => 0,
        onTerminalZoom: () => () => {},
        set: vi.fn()
      }
    }
  })

  afterEach(() => {
    delete (window as unknown as { api?: unknown }).api
  })

  it('shows language as a primary interface control without opening Advanced', async () => {
    mocks.state.settingsSearchQuery = ''
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))
    const languageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="select-trigger"][aria-label="Language"]'
    )
    const advancedTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')
    ).find((button) => button.textContent?.includes('Advanced'))

    expect(languageTrigger).not.toBeNull()
    expect(advancedTrigger).toBeDefined()
    expect(advancedTrigger?.getAttribute('aria-expanded')).toBe('false')
    expect(
      container.querySelector('button[role="switch"][aria-label="Titlebar App Name"]')
    ).toBeNull()
  })

  it('keeps Advanced closed when searching for language', async () => {
    mocks.state.settingsSearchQuery = 'language'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))
    const languageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="select-trigger"][aria-label="Language"]'
    )

    expect(languageTrigger).not.toBeNull()
    expect(container.textContent).not.toContain('Advanced')
    expect(
      container.querySelector('button[role="switch"][aria-label="Titlebar App Name"]')
    ).toBeNull()
  })

  it('renders the language dropdown with system, english, chinese, korean, japanese, and spanish options', async () => {
    mocks.state.settingsSearchQuery = 'language'
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      uiLanguage: 'system' as const
    }

    const container = await renderAppearancePane(settings, updateSettings)
    const languageTrigger = container.querySelector<HTMLButtonElement>(
      '[data-slot="select-trigger"][aria-label="Language"]'
    )
    const chineseOption = container.querySelector<HTMLButtonElement>(
      '[data-slot="select-item"][data-value="zh"]'
    )

    expect(languageTrigger).not.toBeNull()
    expect(chineseOption).not.toBeNull()
    expect(container.textContent).not.toContain('Advanced')
    expect(container.textContent).toContain('System')
    expect(container.textContent).toContain('English')
    expect(container.textContent).toContain('中文（简体）')
    expect(container.textContent).toContain('한국어')
    expect(container.textContent).toContain('日本語')
    expect(container.textContent).toContain('Español')

    await act(async () => {
      chineseOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'zh' })
  })

  it('includes the selected language in the collapsed Interface summary', async () => {
    mocks.state.settingsSearchQuery = ''
    const settings = {
      ...getDefaultSettings('/tmp'),
      uiLanguage: 'zh' as const,
      theme: 'dark' as const,
      appFontFamily: 'Inter'
    }
    const container = await renderAppearancePane(settings)
    const interfaceToggle = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        'button[aria-controls="appearance-section-interface"]'
      )
    )[0]
    expect(interfaceToggle).toBeDefined()
    await act(async () => {
      interfaceToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(interfaceToggle?.getAttribute('aria-expanded')).toBe('false')
    // Summary is only rendered on the collapsed toggle (children stay mounted but hidden).
    expect(interfaceToggle?.textContent).toContain('Dark · 中文（简体） · Inter')
  })

  it('updates the left sidebar appearance from sidebar settings', async () => {
    mocks.state.settingsSearchQuery = 'left sidebar'
    const updateSettings = vi.fn()
    const settings = getDefaultSettings('/tmp')

    const container = await renderAppearancePane(settings, updateSettings)
    const matchTerminalButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    ).find((button) => button.textContent === 'Match Terminal')

    expect(matchTerminalButton).toBeDefined()

    await act(async () => {
      matchTerminalButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({
      leftSidebarAppearanceMode: 'match-terminal'
    })
  })

  it('restores the Automations sidebar button from the sidebar settings switch', async () => {
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      showAutomationsButton: false
    }

    const container = await renderAppearancePane(settings, updateSettings)
    const switchControl = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Show Automations Button"]'
    )

    expect(switchControl).not.toBeNull()
    expect(switchControl?.getAttribute('aria-checked')).toBe('false')

    await act(async () => {
      switchControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ showAutomationsButton: true })
  })

  it('changes workspace card layout from the Appearance sidebar controls', async () => {
    mocks.state.settingsSearchQuery = 'workspace card layout'
    const settings = {
      ...getDefaultSettings('/tmp'),
      compactWorktreeCards: false
    }

    const container = await renderAppearancePane(settings)
    const compactButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    ).find((button) => button.textContent === 'Compact')

    expect(compactButton).toBeDefined()

    await act(async () => {
      compactButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.state.setWorktreeCardMode).toHaveBeenCalledWith('Compact')
  })

  it('renders the three top-level section rows and no Code & Markdown row when not searching', async () => {
    mocks.state.settingsSearchQuery = ''
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    expect(container.textContent).toContain('Interface')
    expect(container.textContent).toContain('Terminal')
    expect(container.textContent).toContain('Window & Sidebar')
    // Code & Markdown is intentionally omitted — Orca has no Appearance-level
    // code/markdown settings, so the row would be empty.
    expect(container.textContent).not.toContain('Code & Markdown')
  })

  it('requests installed font suggestions only after the IDE font picker is used', async () => {
    mocks.state.settingsSearchQuery = ''
    const requestFontSuggestions = vi.fn()
    const container = await renderAppearancePane(getDefaultSettings('/tmp'), vi.fn(), {
      onRequestFontSuggestions: requestFontSuggestions
    })

    expect(requestFontSuggestions).not.toHaveBeenCalled()

    const input = container.querySelector<HTMLInputElement>('input[role="combobox"]')
    expect(input).not.toBeNull()

    await act(async () => {
      input?.focus()
    })

    expect(requestFontSuggestions).toHaveBeenCalledOnce()
  })

  it('keeps the app icon control at the bottom of the pane, after the section rows', async () => {
    mocks.state.settingsSearchQuery = ''
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    const buttons = Array.from(container.querySelectorAll('button'))
    const interfaceRow = buttons.find((button) => button.textContent?.includes('Interface'))
    const appIconImage = container.querySelector<HTMLImageElement>('img[alt="Selected app icon"]')

    expect(interfaceRow).toBeDefined()
    expect(appIconImage).not.toBeNull()
    // The App Icon block sits after the Interface section row in document order.
    expect(
      interfaceRow &&
        appIconImage &&
        interfaceRow.compareDocumentPosition(appIconImage) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it('reveals an advanced sidebar control when its search matches, even though it is hidden by default', async () => {
    // The Show Tasks Button toggle lives behind the Window & Sidebar Advanced
    // disclosure; with no search it stays collapsed, but a matching query must
    // force the disclosure open so the control is reachable.
    mocks.state.settingsSearchQuery = ''
    const collapsedContainer = await renderAppearancePane(getDefaultSettings('/tmp'))
    expect(
      collapsedContainer.querySelector('button[role="switch"][aria-label="Show Tasks Button"]')
    ).toBeNull()

    mocks.state.settingsSearchQuery = 'tasks'
    const searchedContainer = await renderAppearancePane(getDefaultSettings('/tmp'))
    expect(
      searchedContainer.querySelector('button[role="switch"][aria-label="Show Tasks Button"]')
    ).not.toBeNull()
  })

  it('shows and updates the menu bar icon preference only on desktop macOS', async () => {
    mocks.state.appPlatform = 'darwin'
    mocks.state.settingsSearchQuery = 'menu bar'
    const updateSettings = vi.fn()
    const container = await renderAppearancePane(getDefaultSettings('/tmp'), updateSettings)
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Show Menu Bar Icon"]'
    )

    expect(toggle).not.toBeNull()
    expect(container.textContent).not.toContain('Minimize to Tray on Close')
    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(updateSettings).toHaveBeenCalledWith({ showMenuBarIcon: false })
  })

  it('keeps description-only search matches visible after helper text is hidden', async () => {
    mocks.state.settingsSearchQuery = 'app window'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    expect(container.textContent).toContain('Theme')
    expect(container.textContent).not.toContain('Advanced')
  })

  it('shows useful primary rows for a Window & Sidebar section-label search', async () => {
    mocks.state.settingsSearchQuery = 'Window & Sidebar'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    expect(container.textContent).toContain('Left Sidebar Appearance')
    expect(container.textContent).toContain('Status Bar')
    expect(container.textContent).not.toContain('Advanced')
  })

  it('expands status bar controls for a section-label search', async () => {
    mocks.state.availableStatusBarToggles = [
      {
        id: 'ports',
        title: 'Ports',
        description: 'Show live workspace ports in the status bar.',
        toggleDescription: 'Show Ports in the status bar.',
        keywords: ['status bar', 'ports']
      }
    ]
    mocks.state.settingsSearchQuery = 'status bar'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    expect(container.querySelector('button[role="switch"][aria-label="Ports"]')).not.toBeNull()
  })

  it('updates the usage percentage display from the latest status bar settings section', async () => {
    mocks.state.settingsSearchQuery = 'remaining'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))
    const remainingButton = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    ).find((button) => button.textContent === 'Remaining')

    expect(container.textContent).toContain('Usage percentages')
    expect(remainingButton).toBeDefined()

    await act(async () => {
      remainingButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.state.setUsagePercentageDisplay).toHaveBeenCalledWith('remaining')
  })

  it('records MiniMax status bar toggles as usage tracking interactions', async () => {
    mocks.state.availableStatusBarToggles = [
      {
        id: 'minimax',
        title: 'MiniMax Usage',
        description: 'Show MiniMax subscription usage in the status bar.',
        toggleDescription: 'Show MiniMax subscription usage for the active workspace.',
        keywords: ['status bar', 'minimax', 'usage']
      }
    ]
    mocks.state.settingsSearchQuery = 'minimax'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))
    const miniMaxSwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="MiniMax Usage"]'
    )

    expect(miniMaxSwitch).not.toBeNull()
    await act(async () => {
      miniMaxSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.state.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(mocks.state.toggleStatusBarItem).toHaveBeenCalledWith('minimax')
  })

  it('records Antigravity status bar toggles as usage tracking interactions', async () => {
    mocks.state.availableStatusBarToggles = [
      {
        id: 'antigravity',
        title: 'Antigravity Usage',
        description: 'Show Antigravity subscription usage in the status bar.',
        toggleDescription: 'Show Antigravity subscription usage for the active workspace.',
        keywords: ['status bar', 'antigravity', 'usage']
      }
    ]
    mocks.state.settingsSearchQuery = 'antigravity'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))
    const antigravitySwitch = container.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="Antigravity Usage"]'
    )

    expect(antigravitySwitch).not.toBeNull()
    await act(async () => {
      antigravitySwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.state.recordFeatureInteraction).toHaveBeenCalledWith('usage-tracking')
    expect(mocks.state.toggleStatusBarItem).toHaveBeenCalledWith('antigravity')
  })

  it('expands Interface, Terminal, and Window & Sidebar by default', async () => {
    mocks.state.settingsSearchQuery = ''
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    const expanded = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]')
    ).filter((button) => button.getAttribute('aria-controls')?.startsWith('appearance-section-'))

    expect(expanded).toHaveLength(3)
    expect(expanded.map((button) => button.textContent).join(' ')).toContain('Interface')
    expect(expanded.map((button) => button.textContent).join(' ')).toContain('Terminal')
    expect(expanded.map((button) => button.textContent).join(' ')).toContain('Window & Sidebar')
  })

  it('lets each appearance section collapse independently', async () => {
    mocks.state.settingsSearchQuery = ''
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    const terminalToggle = appearanceSectionToggle(container, 'terminal')

    expect(terminalToggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      terminalToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(terminalToggle?.getAttribute('aria-expanded')).toBe('false')

    const stillExpanded = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-expanded="true"]')
    ).filter((button) => button.getAttribute('aria-controls')?.startsWith('appearance-section-'))

    expect(stillExpanded).toHaveLength(2)
    expect(stillExpanded.map((button) => button.textContent).join(' ')).toContain('Interface')
    expect(stillExpanded.map((button) => button.textContent).join(' ')).toContain(
      'Window & Sidebar'
    )
  })

  it('re-opens a collapsed section for appearance deep links without collapsing siblings', async () => {
    mocks.state.settingsSearchQuery = ''
    mocks.state.appearanceAccordionDeepLink = null
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    const windowToggle = appearanceSectionToggle(container, 'window')
    const terminalToggle = appearanceSectionToggle(container, 'terminal')
    expect(windowToggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      windowToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(windowToggle?.getAttribute('aria-expanded')).toBe('false')
    expect(terminalToggle?.getAttribute('aria-expanded')).toBe('true')

    mocks.state.appearanceAccordionDeepLink = 'window'
    await rerenderAppearancePane()

    expect(appearanceSectionToggle(container, 'window')?.getAttribute('aria-expanded')).toBe('true')
    expect(appearanceSectionToggle(container, 'terminal')?.getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(mocks.state.clearAppearanceAccordionDeepLink).toHaveBeenCalled()
  })

  it('disables section toggles while searching so clearing search does not surprise-collapse', async () => {
    mocks.state.settingsSearchQuery = 'terminal'
    const container = await renderAppearancePane(getDefaultSettings('/tmp'))

    const terminalToggle = appearanceSectionToggle(container, 'terminal')
    expect(terminalToggle?.disabled).toBe(true)
    expect(terminalToggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => {
      terminalToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(terminalToggle?.getAttribute('aria-expanded')).toBe('true')

    mocks.state.settingsSearchQuery = ''
    await rerenderAppearancePane()

    const afterClear = appearanceSectionToggle(container, 'terminal')
    expect(afterClear?.disabled).toBe(false)
    expect(afterClear?.getAttribute('aria-expanded')).toBe('true')
  })
})
