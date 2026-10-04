// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { BrowserPane } from './BrowserPane'
import { getBrowserPaneSearchEntries } from './browser-search'
import type * as BrowserSearch from './browser-search'

const fake = vi.hoisted(() => ({
  query: '',
  locale: { language: 'en' },
  translate: vi.fn((_key: string, fallback: string) => fallback),
  setHost: vi.fn(),
  profiles: [],
  repos: [],
  map: new Map(),
  environments: [],
  hostOptions: [{ id: 'local', kind: 'local', label: 'Local' }]
}))
vi.mock('@/i18n/i18n', () => ({ i18n: fake.locale, translate: fake.translate }))
vi.mock('./browser-search', async (importOriginal) => {
  const original = await importOriginal<typeof BrowserSearch>()
  return { ...original, getBrowserPaneSearchEntries: vi.fn(original.getBrowserPaneSearchEntries) }
})
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      browserDefaultUrl: '',
      browserSessionProfiles: fake.profiles,
      repos: fake.repos,
      sshTargetLabels: fake.map,
      sshConnectionStates: fake.map,
      runtimeEnvironments: fake.environments,
      runtimeStatusByEnvironmentId: fake.map,
      browserSessionHostIdOverride: null,
      setBrowserSessionHostId: fake.setHost
    })
}))
vi.mock('@/components/terminal-pane/pane-helpers', () => ({ isMacUserAgent: () => false }))
vi.mock('../sidebar/sidebar-host-options', () => ({
  buildSidebarHostOptions: () => fake.hostOptions
}))
vi.mock('./BrowserHomePageSetting', () => ({
  BrowserHomePageSetting: ({
    value,
    onChange
  }: {
    value: string
    onChange: (value: string) => void
  }) => (
    <input
      aria-label="Home page draft"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}))
vi.mock('./BrowserUsePane', () => ({ BrowserUseSetup: () => <span>Browser use row</span> }))
vi.mock('./BrowserDefaultZoomSetting', () => ({
  BrowserDefaultZoomSetting: () => <span>Zoom row</span>
}))
vi.mock('./BrowserSearchEngineSetting', () => ({
  BrowserSearchEngineSetting: () => <span>Search row</span>
}))
vi.mock('./BrowserLinkRoutingSetting', () => ({
  BrowserLinkRoutingSetting: () => <span>Routing row</span>
}))
vi.mock('./BrowserLinkRoutingModifierSetting', () => ({
  BrowserLinkRoutingModifierSetting: () => <span>Modifier row</span>
}))
vi.mock('./BrowserTerminalLinkActionsSetting', () => ({
  BrowserTerminalLinkActionsSetting: () => <span>Terminal links row</span>
}))
vi.mock('./BrowserLocalhostWorktreeLabelsSetting', () => ({
  BrowserLocalhostWorktreeLabelsSetting: () => <span>Localhost row</span>
}))
vi.mock('./BrowserClientHostedRemoteSetting', () => ({
  BrowserClientHostedRemoteSetting: () => <span>Remote row</span>
}))
vi.mock('./BrowserSshWorkspaceRoutingSetting', () => ({
  BrowserSshWorkspaceRoutingSetting: () => <span>SSH row</span>
}))
vi.mock('./BrowserUserAgentSetting', () => ({
  BrowserUserAgentSetting: () => <span>Identity row</span>
}))
vi.mock('./SettingsFormControls', () => ({ SettingsSubsectionHeader: () => null }))
vi.mock('./BrowserSessionCookiesSection', () => ({
  BrowserSessionCookiesSection: () => <span>Cookies row</span>
}))
vi.mock('./BrowserNewProfileDialog', () => ({ BrowserNewProfileDialog: () => null }))

beforeEach(() => {
  vi.clearAllMocks()
  fake.query = ''
  fake.locale.language = 'en'
  fake.translate.mockImplementation((_key, fallback) => fallback)
})
afterEach(cleanup)
it('builds one catalog per render while typing a home page draft', () => {
  render(<BrowserPane settings={getDefaultSettings('/synthetic')} updateSettings={vi.fn()} />)
  vi.clearAllMocks()
  for (let index = 1; index <= 20; index++) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x'.repeat(index) } })
  }
  expect(getBrowserPaneSearchEntries).toHaveBeenCalledTimes(20)
})
it('keeps targeted search visibility', () => {
  fake.query = 'Default Home Page'
  render(<BrowserPane settings={getDefaultSettings('/synthetic')} updateSettings={vi.fn()} />)
  expect(screen.getByRole('textbox')).toBeTruthy()
  expect(screen.queryByText('Cookies row')).toBeNull()
})

it('rebuilds metadata in the next render after the language changes', () => {
  fake.query = 'Default Home Page'
  const settings = getDefaultSettings('/synthetic')
  const view = render(<BrowserPane settings={settings} updateSettings={vi.fn()} />)
  expect(screen.getByRole('textbox')).toBeTruthy()
  fake.locale.language = 'synthetic-locale'
  fake.query = 'Translated home'
  fake.translate.mockImplementation((_key, fallback) =>
    fallback === 'Default Home Page' ? 'Translated home' : fallback
  )
  vi.mocked(getBrowserPaneSearchEntries).mockClear()
  view.rerender(<BrowserPane settings={settings} updateSettings={vi.fn()} />)
  expect(screen.getByRole('textbox')).toBeTruthy()
  expect(screen.queryByText('Cookies row')).toBeNull()
})
