import React from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
import type { ProjectHostSetupOption } from '@/lib/workspace/creation/project-host-setup-options'
import { NewWorkspaceComposerProjectSection } from '@/components/new-workspace/NewWorkspaceComposerProjectSection'
import { SidebarHeaderActions } from '../../sidebar-header-actions'

const ubuntuRuntime: PublicKnownRuntimeEnvironment = {
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

const multiHostStore = {
  settings: {
    ...getDefaultSettings('/Users/alice/orca'),
    experimentalWslHosts: true
  },
  hostLabelOverrides: new Map([['local', 'Local Mac']] as const),
  sshTargetLabels: new Map([['devbox', 'dev-server']]),
  sshConnectionStates: new Map([
    [
      'devbox',
      {
        targetId: 'devbox',
        status: 'disconnected' as const,
        error: null,
        reconnectAttempt: 0
      }
    ]
  ]),
  runtimeEnvironments: [ubuntuRuntime],
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
          verification: 'verified' as const,
          transport: 'ready' as const
        }
      }
    ]
  ])
}

const composerProjects: NewWorkspaceProjectOption[] = [
  {
    kind: 'project',
    id: 'orca',
    projectId: 'orca',
    displayName: 'orca',
    badgeColor: 'var(--muted-foreground)',
    detail: 'stablyai/orca'
  },
  {
    kind: 'project',
    id: 'platform-api',
    projectId: 'platform-api',
    displayName: 'platform-api',
    badgeColor: 'var(--muted-foreground)',
    detail: 'stablyai/platform-api'
  }
]

const composerHosts: ProjectHostSetupOption[] = [
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

function SidebarHeaderFrame(): React.JSX.Element {
  return (
    <div className="min-h-[260px] rounded-xl border border-border bg-sidebar p-3">
      <div className="flex w-64 items-center justify-between rounded-lg border border-border/60 bg-background/40 px-2.5 py-1.5">
        <span className="text-xs font-semibold text-foreground">Workspaces</span>
        <SidebarHeaderActions onWorkspaceBoardMenuOpenChange={() => {}} />
      </div>
    </div>
  )
}

function ComposerRunOnUbuntuFrame(): React.JSX.Element {
  return (
    <div className="min-h-[300px] space-y-4 rounded-xl border border-border bg-dialog-surface p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">New worktree</h2>
        <span className="rounded border border-border px-1.5 py-0.5 text-2xs text-muted-foreground">
          Esc
        </span>
      </div>
      <NewWorkspaceComposerProjectSection
        projectError={null}
        selectedRepoConnectionId={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        projectOptions={composerProjects}
        selectedProjectId="orca"
        onProjectChange={() => {}}
        projectDescriptionId="fixture-composer-project-desc"
        onAddProject={() => {}}
        onAddProjectEntryRequest={() => {}}
        focusNameInput={() => {}}
        shouldShowRunTargetPicker
        projectHostSetupOptions={composerHosts}
        selectedProjectHostSetupId="setup-ubuntu"
        selectedRepoExecutionHostId="runtime:wsl-ubuntu"
        handleProjectHostSetupChange={() => {}}
        ephemeralVmRecipes={[]}
        handleAddSshHost={() => {}}
        handleAddRemoteServer={() => {}}
        handleConnectRunTargetHost={async () => {}}
        handleSetLocation={() => {}}
        onConnectSelectedRepo={async () => {}}
        sshStatusLabel="Connected"
        connectButtonLabel="Connect"
        selectedProjectName="orca"
      />
    </div>
  )
}

function openTriggerMenu(button: HTMLElement | null): void {
  button?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse'
    })
  )
}

export const sidebarMenu = defineFixture({
  width: 560,
  store: multiHostStore,
  render: () => <SidebarHeaderFrame />,
  interact: async (frame) => {
    openTriggerMenu(frame.querySelector<HTMLButtonElement>('button[aria-label="Add project"]'))
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
})

export const sidebarHostSubmenu = defineFixture({
  width: 620,
  store: multiHostStore,
  render: () => <SidebarHeaderFrame />,
  interact: async (frame) => {
    openTriggerMenu(frame.querySelector<HTMLButtonElement>('button[aria-label="Add project"]'))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const subTrigger = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-sub-trigger"]'
    )
    subTrigger?.dispatchEvent(
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
    )
    subTrigger?.click()
    await new Promise((resolve) => setTimeout(resolve, 160))
  }
})

export const composerSyncedHostMenu = defineFixture({
  width: 620,
  store: multiHostStore,
  render: () => <ComposerRunOnUbuntuFrame />,
  interact: async (frame) => {
    openTriggerMenu(frame.querySelector<HTMLButtonElement>('button[aria-label="Add project"]'))
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
})

export const composerComboboxCascade = defineFixture({
  width: 680,
  store: multiHostStore,
  render: () => <ComposerRunOnUbuntuFrame />,
  interact: async (frame) => {
    frame.querySelector<HTMLInputElement>('[aria-label="Project"][role="combobox"]')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 80))
    const addProjectOption = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((option) => option.textContent?.includes('Add project'))
    addProjectOption?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    addProjectOption?.click()
    await new Promise((resolve) => setTimeout(resolve, 140))
  }
})
