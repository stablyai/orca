// @vitest-environment happy-dom

import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  getProjectHostSetupSelectionKey,
  type ProjectHostSetupOption
} from '@/lib/workspace/creation/project-host-setup-options'
import { NewWorkspaceComposerProjectSection } from '@/components/new-workspace/composer/NewWorkspaceComposerProjectSection'
import { SidebarHeaderActions } from '../../sidebar-header-actions'
import type { AddRepoDialogEntryRequest } from '../dialog/add-repo-dialog-types'

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

  it('opens the native folder picker directly for local Browse folder without opening a modal on cancel', async () => {
    const user = userEvent.setup()
    pickFoldersMock.mockResolvedValueOnce([])

    render(
      <TooltipProvider>
        <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={vi.fn()} />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(await screen.findByRole('menuitem', { name: /Browse folder/ }))

    expect(pickFoldersMock).toHaveBeenCalledOnce()
    expect(useAppStore.getState().activeModal).toBe('none')

    pickFoldersMock.mockResolvedValueOnce(['/Users/alice/new-repo'])
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    await user.click(await screen.findByRole('menuitem', { name: /Browse folder/ }))

    await waitFor(() => expect(useAppStore.getState().activeModal).toBe('add-repo'))
    expect(useAppStore.getState().modalData.entryRequest).toMatchObject({
      kind: 'picked-local-paths',
      paths: ['/Users/alice/new-repo'],
      hostId: 'local'
    })
  })
})

function ComposerHostSyncHarness({
  onRequest
}: {
  onRequest: (request: AddRepoDialogEntryRequest) => void
}): React.JSX.Element {
  const hostOptions: ProjectHostSetupOption[] = [
    {
      kind: 'ready',
      id: 'setup-local',
      projectId: 'orca',
      repoId: 'orca-local',
      hostId: 'local',
      label: 'Local Mac',
      detail: 'Local',
      path: '/Users/alice/orca'
    },
    {
      kind: 'ready',
      id: 'setup-ubuntu',
      projectId: 'orca',
      repoId: 'orca-ubuntu',
      hostId: 'runtime:wsl-ubuntu',
      label: 'Ubuntu-24.04',
      detail: 'WSL',
      path: '/home/alice/orca'
    }
  ]
  const [setupId, setSetupId] = useState('setup-local')
  const activeOption = hostOptions.find((item) => item.id === setupId) ?? hostOptions[0]

  return (
    <TooltipProvider>
      <NewWorkspaceComposerProjectSection
        projectOptions={[
          {
            kind: 'project',
            id: 'orca',
            projectId: 'orca',
            displayName: 'orca',
            badgeColor: 'var(--muted-foreground)',
            detail: 'stablyai/orca'
          }
        ]}
        selectedProjectId="orca"
        onProjectChange={vi.fn()}
        projectError={null}
        projectDescriptionId="desc"
        onAddProject={vi.fn()}
        onAddProjectEntryRequest={onRequest}
        handleOpenRemoteHostDialog={vi.fn()}
        focusNameInput={vi.fn()}
        shouldShowRunTargetPicker
        projectHostSetupOptions={hostOptions}
        selectedProjectHostSetupId={setupId}
        selectedRepoExecutionHostId={activeOption.hostId}
        handleProjectHostSetupChange={(selectionKey) => {
          const next = hostOptions.find(
            (candidate) => getProjectHostSetupSelectionKey(candidate) === selectionKey
          )
          if (next) {
            setSetupId(next.id)
          }
        }}
        ephemeralVmRecipes={[]}
        handleAddSshHost={vi.fn()}
        handleAddRemoteServer={vi.fn()}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={vi.fn()}
        selectedRepoConnectionId={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName="orca"
      />
    </TooltipProvider>
  )
}

describe('AddProjectMenu default host sync in worktree composer', () => {
  it('uses the Run on host selected in the worktree dialog for both the FolderPlus button and ProjectCombobox cascade', async () => {
    const user = userEvent.setup()
    const onRequest = vi.fn<(request: AddRepoDialogEntryRequest) => void>()
    render(<ComposerHostSyncHarness onRequest={onRequest} />)

    // Switch Run on from Local Mac to Ubuntu-24.04.
    await user.click(screen.getByRole('combobox', { name: 'Run on' }))
    await user.click(await screen.findByRole('option', { name: /Ubuntu-24\.04/ }))

    // 1. FolderPlus button above Project defaults to Ubuntu-24.04.
    await user.click(screen.getByRole('button', { name: 'Add project' }))
    expect((await screen.findByRole('menuitem', { name: /Project host:/ })).textContent).toContain(
      'Ubuntu-24.04'
    )
    await user.click(screen.getByRole('menuitem', { name: /Create new project/ }))

    expect(onRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'create',
        hostId: 'runtime:wsl-ubuntu'
      })
    )

    // 2. ProjectCombobox pinned "Add project" cascade also defaults to Ubuntu-24.04 on hover + click.
    await user.click(screen.getByRole('combobox', { name: 'Project' }))
    const addProjectOption = await screen.findByRole('option', { name: /Add project/ })
    fireEvent.mouseEnter(addProjectOption)

    expect((await screen.findByRole('menuitem', { name: /Project host:/ })).textContent).toContain(
      'Ubuntu-24.04'
    )
    await user.click(screen.getByRole('menuitem', { name: /Clone from URL/ }))

    expect(onRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: 'clone',
        hostId: 'runtime:wsl-ubuntu'
      })
    )
  })
})
