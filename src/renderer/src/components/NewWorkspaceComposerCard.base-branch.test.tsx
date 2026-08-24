// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
        updateSettings: vi.fn(),
        projects: [],
        repos: [],
        worktreesByRepo: {}
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
  SetProjectLocationDialog: () => null
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

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
): { container: HTMLDivElement; root: Root } {
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
        baseBranch={undefined}
        onBaseBranchChange={() => {}}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
        onReuseSelectedBranchChange={() => {}}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
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
        branchesEnabled
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        {...overrides}
      />
    )
  })
  return { container, root }
}

function hasBranchFromLabel(container: HTMLElement): boolean {
  return [...container.querySelectorAll('label')].some(
    (candidate) => candidate.textContent?.trim() === 'Branch from'
  )
}

describe('NewWorkspaceComposerCard base branch picker', () => {
  let current: { container: HTMLDivElement; root: Root } | null = null

  afterEach(() => {
    if (current) {
      act(() => current?.root.unmount())
      current.container.remove()
      current = null
    }
  })

  it('shows Branch from for a GitHub issue source', () => {
    current = renderCard({
      smartNameSelection: { kind: 'github-issue', label: '#7 Fix', url: 'https://example.com/i/7' }
    })

    expect(hasBranchFromLabel(current.container)).toBe(true)
  })

  it('shows Branch from for a Linear source', () => {
    current = renderCard({
      smartNameSelection: { kind: 'linear', label: 'ENG-42' }
    })

    expect(hasBranchFromLabel(current.container)).toBe(true)
  })

  it('omits Branch from for a GitHub PR source', () => {
    current = renderCard({
      smartNameSelection: { kind: 'github-pr', label: '#42 Fix', url: 'https://example.com/pr/42' }
    })

    expect(hasBranchFromLabel(current.container)).toBe(false)
  })

  it('omits Branch from for a bare branch source', () => {
    current = renderCard({
      smartNameSelection: { kind: 'branch', label: 'main' }
    })

    expect(hasBranchFromLabel(current.container)).toBe(false)
  })

  it('omits Branch from when nothing is selected', () => {
    current = renderCard({ smartNameSelection: null })

    expect(hasBranchFromLabel(current.container)).toBe(false)
  })

  it('omits Branch from for non-git projects even with a task source', () => {
    current = renderCard({
      selectedRepoIsGit: false,
      smartNameSelection: { kind: 'github-issue', label: '#7 Fix', url: 'https://example.com/i/7' }
    })

    expect(hasBranchFromLabel(current.container)).toBe(false)
  })
})
