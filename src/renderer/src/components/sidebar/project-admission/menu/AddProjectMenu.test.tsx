// @vitest-environment happy-dom

import 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import '@/lib/workspace/creation/project-host-setup-options'
import '@/components/new-workspace/composer/NewWorkspaceComposerProjectSection'
import { SidebarHeaderActions } from '../../sidebar-header-actions'

vi.mock('@/components/new-workspace/project-selection/use-recent-project-ids', () => ({
  useRecentProjectIds: () => []
}))
vi.mock('@/components/sidebar/host-admission/ssh/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

const UBUNTU_RUNTIME: PublicKnownRuntimeEnvironment = {
  id: 'wsl-ubuntu',
  name: 'Ubuntu-24.04',
  source: 'manual',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'default',
  endpoints: [],
  orcadDeployment: {
    kind: 'wsl',
    distro: 'Ubuntu-24.04',
    localPort: 4100,
    remotePort: 4200
  }
}

const initialState = useAppStore.getState()
const originalApi = window.api
const pickFoldersMock = vi.fn<() => Promise<string[]>>()

beforeEach(() => {
  pickFoldersMock.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ...originalApi,
      repos: {
        ...originalApi?.repos,
        pickFolders: pickFoldersMock,
        cloneAbort: vi.fn().mockResolvedValue(undefined)
      }
    }
  })
  useAppStore.setState({
    activeModal: 'none',
    modalData: {},
    settings: {
      ...getDefaultSettings('/tmp/orca-test'),
      experimentalWslHosts: true
    },
    runtimeEnvironments: [UBUNTU_RUNTIME],
    runtimeStatusByEnvironmentId: new Map([
      [
        'wsl-ubuntu',
        {
          checkedAt: 1,
          status: null,
          snapshot: {
            environmentId: 'wsl-ubuntu',
            pairingRevision: 1,
            sequence: 1,
            checkedAt: 1,
            status: null,
            verification: 'verified',
            transport: 'ready'
          }
        }
      ]
    ])
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
  vi.restoreAllMocks()
})

describe('AddProjectMenu in sidebar header', () => {
  it('switches project host without closing the parent menu and forwards the chosen host to Clone', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={vi.fn()} />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Add project' }))
    const hostTrigger = await screen.findByRole('menuitem', { name: /Project host:/ })
    expect(hostTrigger.textContent).toContain('Local')

    await user.click(hostTrigger)
    const ubuntuItem = await screen.findByRole('menuitem', { name: /Ubuntu-24\.04/ })
    fireEvent.click(ubuntuItem)

    // Parent menu stays open with updated host so the user can immediately choose an action.
    expect(screen.getByRole('menuitem', { name: /Clone from URL/ })).not.toBeNull()
    expect(screen.getByRole('menuitem', { name: /Project host:/ }).textContent).toContain(
      'Ubuntu-24.04'
    )

    await user.click(screen.getByRole('menuitem', { name: /Clone from URL/ }))

    expect(useAppStore.getState().activeModal).toBe('add-repo')
    expect(useAppStore.getState().modalData.entryRequest).toMatchObject({
      kind: 'clone',
      hostId: 'runtime:wsl-ubuntu'
    })
  })
})
