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

  // Re-enable when SHOW_UI_LANGUAGE_SETTING is true (second locale shipped).
  it.skip('renders the language selector with system and english options', async () => {
    mocks.state.settingsSearchQuery = 'language'
    const updateSettings = vi.fn()
    const settings = {
      ...getDefaultSettings('/tmp'),
      uiLanguage: 'system' as const
    }

    const container = await renderAppearancePane(settings, updateSettings)
    const languageControl = container.querySelector<HTMLDivElement>(
      '[role="radiogroup"][aria-label="Language"]'
    )

    expect(languageControl).not.toBeNull()
    expect(container.textContent).toContain('System')
    expect(container.textContent).toContain('English')

    const englishOption = Array.from(
      languageControl?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.textContent?.includes('English'))

    expect(englishOption).toBeDefined()

    await act(async () => {
      englishOption?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(updateSettings).toHaveBeenCalledWith({ uiLanguage: 'en' })
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
