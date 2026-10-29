// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '@/store'
import { FloatingWorkspacePane } from './FloatingWorkspacePane'
import { getFloatingWorkspaceSearchEntries } from './floating-workspace-search'
import { matchesSettingsSearch } from './settings-search'

const originalState = useAppStore.getState()
const originalApi = window.api
let saved: GlobalSettings

function SettingsPane(): React.JSX.Element | null {
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  return settings && <FloatingWorkspacePane settings={settings} updateSettings={updateSettings} />
}

beforeEach(() => {
  saved = getDefaultSettings('/home/test')
  delete saved.fileExplorerOpenTarget
  useAppStore.setState({ settings: saved, settingsSearchQuery: '' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { getFloatingTerminalCwd: async () => '/home/test' },
      settings: {
        set: async (updates: Partial<GlobalSettings>) => {
          saved = { ...saved, ...updates }
          return saved
        }
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  vi.unstubAllGlobals()
})

describe('FloatingWorkspacePane file explorer target', () => {
  it('defaults old profiles to the current workspace and saves the selected target through settings', async () => {
    const rendered = render(<SettingsPane />)
    const control = screen.getByRole('combobox', { name: 'File explorer open target' })
    expect(control.textContent).toBe('Current workspace')
    fireEvent.keyDown(control, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: 'Floating workspace' }))
    await waitFor(() => expect(control.textContent).toBe('Floating workspace'))
    expect(useAppStore.getState().settings?.fileExplorerOpenTarget).toBe('floating-workspace')
    expect(saved.fileExplorerOpenTarget).toBe('floating-workspace')

    rendered.unmount()
    render(<SettingsPane />)
    expect(screen.getByRole('combobox', { name: 'File explorer open target' }).textContent).toBe(
      'Floating workspace'
    )
  })

  it('finds the control by its own setting title through both search filters', () => {
    useAppStore.setState({ settingsSearchQuery: 'File explorer open target' })
    expect(
      matchesSettingsSearch('File explorer open target', getFloatingWorkspaceSearchEntries())
    ).toBe(true)
    render(<SettingsPane />)
    expect(screen.getByRole('combobox', { name: 'File explorer open target' })).toBeTruthy()
    expect(screen.getByText(/SSH and remote files stay in the current workspace/)).toBeTruthy()
  })

  it('hides the desktop-only preference and search entry in browser clients', () => {
    Object.defineProperty(window, '__ORCA_WEB_CLIENT__', { configurable: true, value: true })
    try {
      render(<SettingsPane />)
      expect(screen.queryByRole('combobox', { name: 'File explorer open target' })).toBeNull()
      expect(
        matchesSettingsSearch(
          'File explorer open target',
          getFloatingWorkspaceSearchEntries({ includeBrowser: false })
        )
      ).toBe(false)
    } finally {
      Reflect.deleteProperty(window, '__ORCA_WEB_CLIENT__')
    }
  })
})
