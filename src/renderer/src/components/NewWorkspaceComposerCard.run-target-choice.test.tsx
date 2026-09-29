// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import type { WorkspaceCreationTarget } from '@/lib/project-host-workspace-target'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        activeModal: 'none',
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

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <button type="button">Agent picker</button>
}))

vi.mock('@/components/sidebar/AddRemoteHostDialog', () => ({ AddRemoteHostDialog: () => null }))

vi.mock('@/components/new-workspace/SetProjectLocationDialog', () => ({
  SetProjectLocationDialog: () => null
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({ default: () => null }))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

const PROJECT_ID = 'github:stablyai/orca'

function readyOption(id: string, path: string): ProjectHostSetupOption {
  return {
    kind: 'ready',
    id,
    projectId: PROJECT_ID,
    hostId: 'local',
    repoId: id,
    label: 'Local Mac',
    detail: 'orca',
    path
  }
}

const sameHostOptions = [
  readyOption('setup-main', '/Users/alice/orca'),
  readyOption('setup-side', '/Users/alice/worktrees/pr-1')
]

const sameHostCandidates = [
  { projectHostSetupId: 'setup-main', repoId: 'setup-main' },
  { projectHostSetupId: 'setup-side', repoId: 'setup-side' }
] as unknown as readonly WorkspaceCreationTarget[]

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    createRoot(container).render(
      <NewWorkspaceComposerCard
        quickAgent={null}
        onQuickAgentChange={() => {}}
        eligibleRepos={[]}
        repoId=""
        projectOptions={[]}
        selectedProjectId={PROJECT_ID}
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
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        parentWorktreeId={null}
        onParentWorktreeIdChange={() => {}}
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
        branchesEnabled={false}
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        {...overrides}
      />
    )
  })
  return container
}

function runTargetField(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('div[data-run-target-combobox-root="true"]')
}

describe('NewWorkspaceComposerCard run target choice (STA-6080)', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
    document.body.innerHTML = ''
  })

  it('asks which checkout to use instead of pre-selecting one', () => {
    container = renderCard({
      projectHostSetupOptions: sameHostOptions,
      selectedProjectHostSetupId: null,
      runTargetChoiceCandidates: sameHostCandidates
    })

    expect(container.textContent).toContain('This project is set up in 2 places')
    const field = runTargetField(container)
    expect(field?.textContent).not.toContain('/Users/alice/orca')
    expect(field?.querySelector('input')?.placeholder).toBe('Choose target')
  })

  it('offers every same-host checkout as its own row', () => {
    container = renderCard({
      projectHostSetupOptions: sameHostOptions,
      selectedProjectHostSetupId: null,
      runTargetChoiceCandidates: sameHostCandidates
    })

    act(() => runTargetField(container as HTMLElement)?.click())

    const paths = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].map(
      (row) => row.textContent ?? ''
    )
    expect(paths.some((text) => text.includes('/Users/alice/orca'))).toBe(true)
    expect(paths.some((text) => text.includes('/Users/alice/worktrees/pr-1'))).toBe(true)
  })

  it('stays silent when a single setup resolved', () => {
    container = renderCard({
      projectHostSetupOptions: [sameHostOptions[0]],
      selectedProjectHostSetupId: 'setup-main',
      runTargetChoiceCandidates: null
    })

    expect(container.textContent).not.toContain('This project is set up in')
    expect(runTargetField(container)?.textContent).toContain('/Users/alice/orca')
  })
})
