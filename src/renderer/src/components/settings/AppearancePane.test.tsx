// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  state: {
    settingsSearchQuery: 'automations',
    statusBarItems: [],
    toggleStatusBarItem: vi.fn(),
    recordFeatureInteraction: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyCombos: () => []
}))

vi.mock('../status-bar/use-available-status-bar-toggles', () => ({
  useAvailableStatusBarToggles: () => []
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
  updateSettings: (updates: Partial<GlobalSettings>) => void = vi.fn()
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <AppearancePane
          settings={settings}
          updateSettings={updateSettings}
          applyTheme={vi.fn()}
          fontSuggestions={[]}
          terminalFontSuggestions={[]}
          systemPrefersDark={false}
          ghostty={createGhosttyStub() as never}
          warpThemes={createWarpThemesStub() as never}
        />
      </I18nextProvider>
    )
  })

  return container
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
    mocks.state.settingsSearchQuery = 'automations'
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
})
