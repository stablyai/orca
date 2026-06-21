// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      openModal: vi.fn(),
      activeModal: null,
      settings: { defaultTuiAgent: null, disabledTuiAgents: [] },
      updateSettings: vi.fn()
    })
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

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => <div data-testid="sparse-select" />
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: ({
    branchesEnabled,
    repoBackedSourcesDisabled,
    repoBackedSearchRepos = []
  }: {
    branchesEnabled?: boolean
    repoBackedSourcesDisabled?: boolean
    repoBackedSearchRepos?: { displayName: string }[]
  }) => (
    <input
      aria-label="workspace name"
      data-branches-enabled={branchesEnabled ? 'true' : 'false'}
      data-repo-backed-search-count={repoBackedSearchRepos.length}
      data-repo-backed-search-names={repoBackedSearchRepos
        .map((repo) => repo.displayName)
        .join(',')}
      data-repo-backed-sources-disabled={repoBackedSourcesDisabled ? 'true' : 'false'}
    />
  )
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: ({
    options,
    value,
    onValueChange
  }: {
    options: NewWorkspaceProjectOption[]
    value: string | null
    onValueChange: (value: string) => void
  }) => (
    <div data-testid="project-combobox" data-value={value ?? ''}>
      {options.map((option) => (
        <button key={option.id} type="button" onClick={() => onValueChange(option.id)}>
          {option.displayName}
        </button>
      ))}
    </div>
  )
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

const sourceRepos = [
  {
    id: 'repo-a',
    displayName: 'Repo A',
    path: '/repo-a',
    badgeColor: '#111111'
  },
  {
    id: 'repo-b',
    displayName: 'Repo B',
    path: '/repo-b',
    badgeColor: '#222222'
  }
]

function renderCard(
  overrides: Partial<React.ComponentProps<typeof NewWorkspaceComposerCard>> = {}
) {
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
  return { container, root }
}

let current: { container: HTMLDivElement; root: Root } | null = null

describe('NewWorkspaceComposerCard folder task source mode', () => {
  afterEach(() => {
    act(() => current?.root.unmount())
    current?.container.remove()
    current = null
  })

  it('passes folder child repos into the create-from field without a source trigger', () => {
    current = renderCard({
      repoBackedSearchRepos: sourceRepos as never
    })

    const projectSection = current.container.querySelector(
      '[data-contextual-tour-target="workspace-creation-project"]'
    )
    const nameSection = current.container.querySelector(
      '[data-contextual-tour-target="workspace-creation-name"]'
    )
    expect(projectSection?.textContent).not.toContain('Task Source')
    expect(nameSection?.textContent).toContain("Name or 'Create From'")
    expect(
      current.container
        .querySelector('[aria-label="workspace name"]')
        ?.getAttribute('data-repo-backed-search-count')
    ).toBe('2')
    expect(
      current.container
        .querySelector('[aria-label="workspace name"]')
        ?.getAttribute('data-repo-backed-search-names')
    ).toBe('Repo A,Repo B')
    expect(current.container.querySelector('[data-testid="repo-backed-source-trigger"]')).toBeNull()
    expect(current.container.querySelectorAll('[data-testid="project-combobox"]')).toHaveLength(1)
  })

  it('keeps the reuse-branch row collapsed until a local branch is reusable', () => {
    // Why: the row stays mounted (for the smooth height transition) but is
    // collapsed + aria-hidden when reuse isn't possible.
    current = renderCard({ canReuseSelectedBranch: false })
    const collapsedReuse = [...current.container.querySelectorAll('[aria-hidden="true"]')].find(
      (el) => el.textContent?.includes('Reuse branch')
    )
    expect(collapsedReuse).toBeTruthy()

    act(() => current?.root.unmount())
    current?.container.remove()

    current = renderCard({ canReuseSelectedBranch: true, reuseSelectedBranch: true })
    const reuseLabel = [...current.container.querySelectorAll('label')].find((label) =>
      label.textContent?.includes('Reuse branch')
    )
    expect(reuseLabel).toBeTruthy()
    // Visible: not inside an aria-hidden (collapsed) wrapper.
    expect(reuseLabel?.closest('[aria-hidden="true"]')).toBeNull()
    expect(current.container.textContent).toContain(
      'Check out the existing branch instead of creating a new one from it.'
    )
  })

  it('emits the toggled value from the reuse checkbox in both directions', () => {
    const clickReuseCheckbox = (): void => {
      const reuseLabel = [...(current?.container.querySelectorAll('label') ?? [])].find((label) =>
        label.textContent?.includes('Reuse branch')
      )
      const checkbox = reuseLabel?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      expect(checkbox).toBeTruthy()
      act(() => checkbox?.click())
    }

    // Checked -> unchecked (opting out of reuse).
    const offChanges: boolean[] = []
    current = renderCard({
      canReuseSelectedBranch: true,
      reuseSelectedBranch: true,
      onReuseSelectedBranchChange: (next) => offChanges.push(next)
    })
    clickReuseCheckbox()
    expect(offChanges).toEqual([false])

    act(() => current?.root.unmount())
    current?.container.remove()

    // Unchecked -> checked (opting into reuse — the action that pins the branch).
    const onChanges: boolean[] = []
    current = renderCard({
      canReuseSelectedBranch: true,
      reuseSelectedBranch: false,
      onReuseSelectedBranchChange: (next) => onChanges.push(next)
    })
    clickReuseCheckbox()
    expect(onChanges).toEqual([true])
  })

  it('does not disable folder workspace creation when only source lookup needs SSH', () => {
    current = renderCard({
      eligibleRepos: [
        { id: 'repo-a', displayName: 'Repo A', path: '/repo-a', connectionId: 'ssh-a' } as never
      ],
      repoBackedSearchRepos: sourceRepos as never,
      repoBackedSourcesDisabled: false
    })

    const createButton = [...current.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Create workspace')
    )
    expect(createButton).toBeTruthy()
    expect(createButton?.hasAttribute('disabled')).toBe(false)
    expect(
      current.container
        .querySelector('[aria-label="workspace name"]')
        ?.getAttribute('data-repo-backed-sources-disabled')
    ).toBe('false')
  })
})
