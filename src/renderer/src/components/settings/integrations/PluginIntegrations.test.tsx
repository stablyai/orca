// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../shared/plugins/plugin-list-entry'

const { app } = vi.hoisted(() => ({
  app: { openSettingsTarget: vi.fn(), openSettingsPage: vi.fn() }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => app } }))
vi.mock('@/store/index', () => ({ useAppStore: { getState: () => app } }))
vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace('{{name}}', options?.name ?? '')
}))
vi.mock('@/components/right-sidebar/plugin-panels/PluginPanel', () => ({
  default: ({ tabKey }: { tabKey: string }) => <div data-testid="settings-panel">{tabKey}</div>
}))

import { PluginIntegrationSettings, PluginIntegrationsGroup } from './PluginIntegrations'
import { usePluginIntegrationNavigation } from './plugin-integration-navigation'
import {
  collectActivePluginPanels,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { openPluginSettings } from '@/components/plugins/view/plugin-view-host-actions'

const plugin: PluginHostListEntry = {
  pluginKey: 'acme.tasks',
  name: 'Acme Tasks',
  version: '1.0.0',
  publisher: 'acme',
  consentFingerprint: 'test',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  commands: [],
  hasWorker: true,
  hasSettings: true,
  restarts: 0,
  panels: [
    { id: 'tasks', title: 'Tasks', tabKey: 'plugin:acme.tasks/tasks' },
    {
      id: 'connection',
      title: 'Task connection',
      location: 'settings',
      tabKey: 'plugin:acme.tasks/connection'
    }
  ]
}
let installed: PluginHostListEntry[]
let url: string
const setSetting = vi.fn(async ({ value }: { value: string }) => {
  url = value
  return { ok: true }
})

function Integrations(): React.JSX.Element {
  const selected = usePluginIntegrationNavigation((state) => state.pluginKey)
  return selected ? <PluginIntegrationSettings pluginKey={selected} /> : <PluginIntegrationsGroup />
}

beforeEach(() => {
  installed = [plugin]
  url = ''
  app.openSettingsTarget.mockClear()
  app.openSettingsPage.mockClear()
  setSetting.mockClear()
  usePluginIntegrationNavigation.getState().show(null)
  usePluginPanelsStore.getState().setPlugins(installed)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        list: async () => installed,
        getSettings: async () => ({
          settings: [{ key: 'api_url', title: 'Server URL', type: 'string' }],
          values: { api_url: url }
        }),
        setSetting
      }
    }
  })
})
afterEach(() => {
  cleanup()
  usePluginPanelsStore.getState().setPlugins([])
  usePluginIntegrationNavigation.getState().show(null)
})

it('opens an installed plugin connection in Integrations and edits its existing own settings', async () => {
  render(<Integrations />)
  expect(collectActivePluginPanels([plugin]).map((panel) => panel.tabKey)).toEqual([
    'plugin:acme.tasks/tasks'
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Configure Acme Tasks' }))
  expect(screen.getByTestId('settings-panel').textContent).toBe('plugin:acme.tasks/connection')
  expect(app.openSettingsTarget).toHaveBeenCalledWith({
    pane: 'integrations',
    repoId: null,
    sectionId: 'plugin-integration-settings'
  })
  fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
  const input = await screen.findByLabelText('Server URL')
  fireEvent.change(input, { target: { value: 'https://tasks.example' } })
  await act(async () => {
    fireEvent.blur(input)
  })
  expect(setSetting).toHaveBeenCalledWith({
    pluginKey: 'acme.tasks',
    key: 'api_url',
    value: 'https://tasks.example'
  })
  fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
  expect(screen.queryByTestId('settings-panel')).toBeNull()
  expect(screen.getByRole('button', { name: 'Configure Acme Tasks' })).toBeTruthy()
})

it('rechecks installed authority for host navigation and unmounts a disabled settings panel', async () => {
  render(<Integrations />)
  await act(async () => {
    expect(
      await openPluginSettings({
        kind: 'open-plugin-settings',
        requestId: 'open',
        pluginKey: 'acme.tasks'
      })
    ).toEqual({ requestId: 'open', ok: true })
  })
  expect(screen.getByTestId('settings-panel').textContent).toBe('plugin:acme.tasks/connection')
  installed = [{ ...plugin, status: 'disabled' }]
  await act(async () => {
    expect(
      await openPluginSettings({
        kind: 'open-plugin-settings',
        requestId: 'disabled',
        pluginKey: 'acme.tasks'
      })
    ).toMatchObject({ ok: false, code: 'action_unavailable' })
  })
  expect(screen.queryByTestId('settings-panel')).toBeNull()
  expect(screen.getByRole('button', { name: 'Manage plugin' })).toBeTruthy()
})
