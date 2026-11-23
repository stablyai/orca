// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { RuntimeServersPageProvider } from '../runtime-servers-page-context'
import { RuntimeEnvironmentsPane } from './RuntimeEnvironmentsPane'

// Stub each section so the test reads only the order the pane renders them in.
const { section } = vi.hoisted(() => ({
  section: (testId: string) =>
    function Section(): React.JSX.Element {
      return <div data-testid={testId} />
    }
}))
vi.mock('../pairing/runtime-share-computer-section', () => ({
  RuntimeShareComputerSection: section('share-computer')
}))
vi.mock('./runtime-default-host-row', () => ({ RuntimeDefaultHostRow: section('default-host') }))
vi.mock('../server-rows/runtime-server-list-header', () => ({
  RuntimeServerListHeader: section('server-list-header')
}))
vi.mock('../server-rows/runtime-server-list', () => ({ RuntimeServerList: section('server-list') }))
vi.mock('../../wsl/hosts/WslHostsSection', () => ({ WslHostsSection: section('wsl-hosts') }))
vi.mock('../../virtual-machines/runtimes/EphemeralVmRuntimesSection', () => ({
  EphemeralVmRuntimesSection: section('vm-runtimes')
}))
vi.mock('../pairing/runtime-add-server-dialog', () => ({ RuntimeAddServerDialog: () => null }))
vi.mock('../managed-servers/runtime-install-server-dialog', () => ({
  RuntimeInstallServerDialog: () => null
}))
vi.mock('./runtime-environment-dialogs', () => ({
  RuntimeEnvironmentRemoveDialog: () => null,
  RuntimeEnvironmentSwitchDialog: () => null
}))
vi.mock('./use-runtime-environment-catalog', () => ({
  useRuntimeEnvironmentCatalog: () => ({
    environments: [],
    isLoading: false,
    detailsByEnvironmentId: {},
    setDetailsByEnvironmentId: () => {},
    mountedRef: { current: true },
    loadEnvironments: async () => {}
  })
}))
vi.mock('../managed-servers/use-managed-server-catalog', () => ({
  useManagedServerCatalog: () => ({ api: undefined, loadFailed: false, reload: async () => {} })
}))
vi.mock('./use-runtime-environment-connection-actions', () => ({
  useRuntimeEnvironmentConnectionActions: () => ({
    connectingId: null,
    switchingValue: null,
    disconnectingId: null,
    switchError: null,
    setSwitchError: () => {}
  })
}))
vi.mock('./use-runtime-environment-mutation-actions', () => ({
  useRuntimeEnvironmentMutationActions: () => ({
    isSaving: false,
    removingId: null,
    setRemoveError: () => {}
  })
}))
vi.mock('@/store/index', () => {
  const state = {
    remoteServerUpdates: new Map(),
    remoteServerUpdatesRunning: false,
    refreshRemoteServerUpdates: async () => {},
    setRemoteServerUpdateDialogOpen: () => {}
  }
  const useAppStore = (select: (value: typeof state) => unknown): unknown => select(state)
  useAppStore.getState = () => ({ ...state, runtimeEnvironments: [] })
  return { useAppStore }
})
vi.mock('@/store/retained-views/app-state-view', () => ({
  useAppStateValue: (select: (state: { settingsSearchQuery: string }) => unknown) =>
    select({ settingsSearchQuery: '' })
}))

afterEach(cleanup)

function renderPane(canGeneratePairingUrl: boolean): string[] {
  render(
    <RuntimeServersPageProvider>
      <RuntimeEnvironmentsPane
        settings={{ activeRuntimeEnvironmentId: null } as GlobalSettings}
        setActiveRuntimeEnvironmentPreference={async () => true}
        canGeneratePairingUrl={canGeneratePairingUrl}
        allowLocalRuntime={canGeneratePairingUrl}
      />
    </RuntimeServersPageProvider>
  )
  return screen.getAllByTestId(/.+/).map((element) => element.dataset.testid ?? '')
}

it('puts This computer first, above the default host and the server list', () => {
  expect(renderPane(true)).toEqual([
    'share-computer',
    'default-host',
    'server-list-header',
    'server-list',
    'vm-runtimes'
  ])
})

it('starts with the default host in the browser client, which cannot share', () => {
  expect(renderPane(false)).toEqual([
    'default-host',
    'server-list-header',
    'server-list',
    'vm-runtimes'
  ])
})
