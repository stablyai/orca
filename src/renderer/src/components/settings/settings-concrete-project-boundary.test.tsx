// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { i18n } from '@/i18n/i18n'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '../ui/tooltip'
import { ActiveSettingsSectionProvider } from './SettingsSection'
import { buildSettingsProjectList } from './settings-project-list'
import { renderProjectSettingsSections } from './settings-project-section-renderer'
import { getRepositoryPaneSearchEntries } from './repository/repository-search'
import { useSettingsTerminalModel } from './use-settings-terminal-model'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsRenderContext } from './settings-render-context'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type * as WindowsTerminalCapabilities from '@/lib/windows-terminal-capabilities'

vi.mock('@/lib/windows-terminal-capabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof WindowsTerminalCapabilities>()),
  isWindowsTerminalCapabilityHost: () => false,
  useWindowsTerminalCapabilities: () => ({}),
  useLocalWindowsTerminalCapabilities: () => ({})
}))
vi.mock('@/hooks/useWindowsTerminalCapabilityOwnerKey', () => ({
  useWindowsTerminalCapabilityOwnerKey: () => 'local'
}))
afterEach(async () => {
  await i18n.changeLanguage('en')
  i18n.removeResourceBundle('fr', 'translation')
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it('keeps retained server Settings available without borrowing local hooks/path/writes, and binds late/removed/switched concrete owners', async () => {
  const local: Repo = {
    id: 'same',
    path: '/local/app',
    executionHostId: 'local',
    displayName: 'App',
    badgeColor: '',
    addedAt: 0,
    upstream: { owner: 'org', repo: 'app' }
  }
  const server: Repo = { ...local, path: '/server/app', executionHostId: 'runtime:server' }
  const projection = projectHostSetupProjectionFromRepos([local, server])
  const settings = getDefaultSettings('')
  const updateRepo = vi.fn()
  const updateProject = vi.fn()
  Object.assign(window, {
    api: { preflight: { detectAgents: async () => [] }, fs: { readDir: async () => [] } }
  })
  useAppStore.setState({
    settings,
    projects: projection.projects,
    projectHostSetups: projection.setups
  })
  let needed: Repo[] = []
  function Harness({
    repos,
    host,
    query: _query = ''
  }: {
    repos: Repo[]
    host: 'local' | 'runtime:server'
    query?: string
  }) {
    const entries = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups,
      settings
    })
    const entry = entries[0]
    const section = `repo-${entry.selectionKey}`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the fields read by the real terminal model and project-section renderer.
    const model = {
      repos,
      settings,
      settingsProjectList: entries,
      activeSectionId: section,
      settingsProjectHostSelection: { [entry.selectionKey]: host },
      settingsProjectSetupSelection: {},
      settingsHostScope: { target: { kind: 'local' }, available: true },
      isWindows: false,
      isWebClient: false,
      mountedSectionIds: new Set([section]),
      setMountedSectionIds: vi.fn(),
      updateRepo,
      updateProject,
      updateSettings: vi.fn(),
      repoHooksMap: {
        'local\0same': { hooks: { scripts: { setup: 'LOCAL ONLY' } }, hasHooks: true }
      },
      removeProjectAllHosts: vi.fn()
    } as unknown as SettingsStoreModel
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the terminal model reads only neededSectionIds; the renderer uses this search metadata method.
    const navigation = {
      neededSectionIds: new Set([section]),
      getSectionSearchEntries: () => getRepositoryPaneSearchEntries(server)
    } as unknown as SettingsNavigationModel
    const terminal = useSettingsTerminalModel(model, navigation)
    needed = terminal.neededRepos
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: supplies every field read by renderProjectSettingsSections.
    const context = {
      model,
      navigation,
      terminal,
      view: { isSectionMounted: () => true }
    } as unknown as SettingsRenderContext
    return (
      <TooltipProvider>
        <ActiveSettingsSectionProvider value={section}>
          {renderProjectSettingsSections(context)}
        </ActiveSettingsSectionProvider>
      </TooltipProvider>
    )
  }
  const user = userEvent.setup()
  const view = render(<Harness repos={[local]} host="runtime:server" />)
  expect(needed).toEqual([])
  expect(screen.queryByLabelText('Display Name')).toBeNull()
  expect(screen.queryByText('/local/app', { selector: 'section > div > p' })).toBeNull()
  expect(screen.getByText('Available Hosts')).toBeTruthy()
  expect(updateRepo).not.toHaveBeenCalled()
  view.rerender(<Harness repos={[local, server]} host="runtime:server" />)
  expect(needed).toEqual([server])
  await user.type(screen.getByLabelText('Display Name'), ' changed')
  expect(updateRepo).toHaveBeenLastCalledWith(
    'same',
    expect.objectContaining({ displayName: expect.stringContaining('changed') }),
    { hostId: 'runtime:server' }
  )
  view.rerender(<Harness repos={[local]} host="runtime:server" />)
  expect(needed).toEqual([])
  expect(screen.queryByLabelText('Display Name')).toBeNull()
  view.rerender(<Harness repos={[local, server]} host="local" />)
  expect(needed).toEqual([local])
  await user.type(screen.getByLabelText('Display Name'), ' local')
  expect(updateRepo).toHaveBeenLastCalledWith('same', expect.anything(), { hostId: 'local' })
  // Sole unstamped/unconnected legacy rows remain usable; ambiguous legacy rows cannot impersonate a stamped server.
  const { executionHostId: _host, ...legacy } = local
  view.rerender(<Harness repos={[legacy]} host="runtime:server" />)
  expect(needed).toEqual([legacy])
  view.rerender(<Harness repos={[legacy, { ...legacy, path: '/other' }]} host="runtime:server" />)
  expect(needed).toEqual([])
  // Exported search metadata and the actual containing identity section share the grouping entry.
  for (const query of ['Group checkouts', '', 'App', 'Group checkouts']) {
    act(() => useAppStore.setState({ settingsSearchQuery: query, settingsSearchInputQuery: query }))
    view.rerender(<Harness repos={[local, server]} host="runtime:server" query={query} />)
    expect(screen.getByRole('combobox', { name: 'Group checkouts' })).toBeTruthy()
  }
  // A translated label must be the same search entry used by both section and inner row.
  await act(async () => {
    await i18n.changeLanguage('fr')
    i18n.addResource('fr', 'translation', 'settings.projectGrouping.label', 'Regrouper les copies')
    useAppStore.setState({
      settingsSearchQuery: 'Regrouper les copies',
      settingsSearchInputQuery: 'Regrouper les copies'
    })
  })
  view.rerender(<Harness repos={[local, server]} host="runtime:server" />)
  expect(getRepositoryPaneSearchEntries(server)[0].title).toBe('Regrouper les copies')
  expect(screen.getByRole('combobox', { name: 'Regrouper les copies' })).toBeTruthy()
})
