// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PluginHostListEntry } from '../../../../../preload/api-types'
import { useAppStore } from '@/store'
import { usePluginLanguagePackStore } from '@/store/plugin-language-packs'
import { usePluginSyntaxStore } from '@/store/plugin-syntax-packs'
import { PluginAddsSection } from './PluginAddsSection'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), message: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

const gleam: PluginHostListEntry = {
  pluginKey: 'stablyai.gleam',
  consentFingerprint: 'sha256-gleam',
  name: 'Gleam',
  version: '1.0.0',
  publisher: 'stablyai',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [],
  hasWorker: false,
  execution: 'data',
  restarts: 0,
  source: { kind: 'local-path', reference: '/tmp/gleam', resolvedCommit: null, contentHash: 'h' }
}
const hello: PluginHostListEntry = {
  ...gleam,
  pluginKey: 'samples.hello-orca',
  consentFingerprint: 'sha256-hello',
  name: 'Hello Orca',
  publisher: 'samples',
  status: 'running',
  hasWorker: true,
  execution: 'trusted-worker',
  panels: [{ id: 'hello', title: 'Hello Orca', tabKey: 'plugin:samples.hello-orca/hello' }],
  commands: [
    {
      id: 'ping',
      title: 'Hello: Ping',
      context: 'global',
      handler: { type: 'worker' },
      keybindings: []
    },
    {
      id: 'here',
      title: 'Hello: Here',
      context: 'workspace',
      handler: { type: 'worker' },
      keybindings: []
    }
  ]
}
const invokeCommand = vi.fn()
const getInstalledManifest = vi.fn()

function renderAdds(plugin: PluginHostListEntry): void {
  render(
    <PluginAddsSection
      plugin={plugin}
      preview={null}
      summary={undefined}
      themePreview={undefined}
      types={[]}
      onOpenShortcuts={vi.fn()}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { invokeCommand, getInstalledManifest } }
  })
  getInstalledManifest.mockResolvedValue(null)
  usePluginSyntaxStore.setState({
    loaded: true,
    entries: [
      {
        id: 'plugin:stablyai.gleam/gleam',
        pluginKey: 'stablyai.gleam',
        label: 'Gleam',
        extensions: ['.gleam'],
        filenames: [],
        revision: '1'
      }
    ]
  })
  usePluginLanguagePackStore.setState({ loaded: true, entries: [] })
})

afterEach(() => {
  cleanup()
  invokeCommand.mockReset()
  getInstalledManifest.mockReset()
  toast.success.mockClear()
  usePluginSyntaxStore.setState({ entries: [], loaded: false })
  usePluginLanguagePackStore.setState({ entries: [], loaded: false })
  useAppStore.setState({
    activeWorktreeId: null,
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer'
  })
})

it('explains inline why a workspace command and the panel are off without a workspace', () => {
  renderAdds(hello)
  expect(screen.getByRole('button', { name: 'Run Hello: Here' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Open panel: Hello Orca' })).toBeDisabled()
  expect(screen.getAllByText('Needs an open workspace')).toHaveLength(2)
})

it('opens a live panel over the workspace Settings came from', () => {
  useAppStore.setState({ activeWorktreeId: 'wt-1', previousViewBeforeSettings: 'terminal' })
  renderAdds(hello)
  fireEvent.click(screen.getByRole('button', { name: 'Open panel: Hello Orca' }))
  const state = useAppStore.getState()
  expect(state.activeView).toBe('terminal')
  expect(state.rightSidebarTab).toBe('plugin:samples.hello-orca/hello')
  expect(state.rightSidebarOpen).toBe(true)
})
