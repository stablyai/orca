// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'

const storeMocks = vi.hoisted(() => ({
  closeModal: vi.fn(),
  openModal: vi.fn(),
  openSettingsPage: vi.fn(),
  openSettingsTarget: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: storeMocks.closeModal,
        openModal: storeMocks.openModal,
        openSettingsPage: storeMocks.openSettingsPage,
        openSettingsTarget: storeMocks.openSettingsTarget,
        setRuntimeEnvironmentStatus: vi.fn(),
        setupProjectExistingFolder: vi.fn(),
        setupProjectClone: vi.fn(),
        activeModal: 'new-workspace-composer',
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: []
      }),
    { getState: () => ({}) }
  )
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({
  AddRemoteHostDialog: () => null
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => null
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: ({
    option,
    projectName
  }: {
    option: { label: string } | null
    projectName: string
  }) =>
    option ? (
      <div
        data-testid="set-project-location-dialog"
        data-host={option.label}
        data-project={projectName}
      />
    ) : null
}))

const projectOptions: NewWorkspaceProjectOption[] = [
  {
    kind: 'project-group',
    id: 'project-group:platform',
    projectGroupId: 'platform',
    displayName: 'Platform',
    badgeColor: 'var(--muted-foreground)',
    detail: '/workspace/platform',
    parentPath: '/workspace/platform',
    connectionId: null
  }
]

const hostOptions: ProjectHostSetupOption[] = [
  {
    kind: 'ready',
    id: 'setup-local',
    projectId: 'project-group:platform',
    hostId: 'local',
    repoId: 'repo-a',
    label: 'Local Mac',
    detail: 'Orca',
    path: '/Users/alice/orca'
  },
  {
    kind: 'needs-setup',
    id: 'needs-setup:ssh:devbox',
    projectId: 'project-group:platform',
    hostId: 'ssh:devbox',
    label: 'Devbox',
    detail: 'Project location not set',
    isAvailable: true,
    attention: false,
    canSetLocation: true
  }
]

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <NewWorkspaceComposerCard
        quickAgent={null}
        onQuickAgentChange={() => {}}
        eligibleRepos={[]}
        repoId="repo-a"
        projectOptions={projectOptions}
        selectedProjectId="project-group:platform"
        selectedRepoIsGit
        onRepoChange={() => {}}
        onProjectChange={() => {}}
        primaryActionLabel="Create workspace"
        name=""
        onNameValueChange={() => {}}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={null}
        onClearSmartNameSelection={() => {}}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
        onReuseSelectedBranchChange={() => {}}
        forkPushWarning={null}
        detectedAgentIds={null}
        onOpenAgentSettings={() => {}}
        advancedOpen={false}
        onToggleAdvanced={() => {}}
        createDisabled={false}
        projectError={null}
        creating={false}
        onCreate={() => {}}
        note=""
        onNoteChange={() => {}}
        setupConfig={null}
        requiresExplicitSetupChoice={false}
        setupDecision={null}
        onSetupDecisionChange={() => {}}
        setupAgentStartupPolicy="start-immediately"
        onSetupAgentStartupPolicyChange={() => {}}
        shouldWaitForSetupCheck={false}
        resolvedSetupDecision={null}
        createError={null}
        selectedRepoConnectionId={null}
        selectedRepoSshStatus={null}
        selectedRepoRequiresConnection={false}
        selectedRepoConnectInProgress={false}
        onConnectSelectedRepo={async () => {}}
        canUseSparseCheckout={false}
        sparsePresets={[]}
        sparseSelectedPresetId={null}
        onSparseSelectPreset={() => {}}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        branchesEnabled={false}
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        projectHostSetupOptions={hostOptions}
        selectedProjectHostSetupId="setup-local"
        {...overrides}
      />
    )
  })
  return container
}

describe('NewWorkspaceComposerCard set location', () => {
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    storeMocks.closeModal.mockReset()
    storeMocks.openModal.mockReset()
    storeMocks.openSettingsPage.mockReset()
  })

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('opens set-location over the composer without leaving the create dialog', () => {
    const nestedOpenChanges: boolean[] = []
    container = renderCard({
      onNestedDialogOpenChange: (open) => nestedOpenChanges.push(open)
    })

    act(() => {
      container?.querySelector<HTMLElement>('div[data-run-target-combobox-root="true"]')?.click()
    })
    const setLocation = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Set project location')
    )
    expect(setLocation).toBeTruthy()
    act(() => setLocation?.click())

    const dialog = document.body.querySelector('[data-testid="set-project-location-dialog"]')
    expect(dialog?.getAttribute('data-host')).toBe('Devbox')
    expect(dialog?.getAttribute('data-project')).toBe('Platform')
    expect(nestedOpenChanges).toEqual([true])
    expect(storeMocks.closeModal).not.toHaveBeenCalled()
    expect(storeMocks.openModal).not.toHaveBeenCalled()
    expect(storeMocks.openSettingsPage).not.toHaveBeenCalled()
  })
})
