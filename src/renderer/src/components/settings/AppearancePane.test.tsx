// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      <AppearancePane
        settings={settings}
        updateSettings={updateSettings}
        applyTheme={vi.fn()}
        fontSuggestions={[]}
        terminalFontSuggestions={[]}
        systemPrefersDark={false}
        ghostty={createGhosttyStub() as never}
      />
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
