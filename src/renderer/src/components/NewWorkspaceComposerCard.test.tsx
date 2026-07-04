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
        branchNameOverride=""
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
        branchesEnabled={false}
        setupControlsEnabled={false}
        sparseControlsEnabled={false}
        {...overrides}
      />
    )
  })
  return { container, root }
}

function findInputByLabel(container: HTMLElement, labelText: string): HTMLInputElement | null {
  const label = [...container.querySelectorAll('label')].find(
    (candidate) => candidate.textContent?.trim() === labelText
  )
  const labelledId = label?.getAttribute('for')
  if (labelledId) {
    return document.getElementById(labelledId) as HTMLInputElement | null
  }
  return label?.parentElement?.querySelector<HTMLInputElement>('input') ?? null
}

function changeInputValue(input: HTMLInputElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    valueSetter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
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

  it('shows the setup startup policy toggle only when setup is available', () => {
    current = renderCard({
      advancedOpen: true,
      setupControlsEnabled: true,
      setupConfig: {
        source: 'yaml',
        command: '# defaultTabs[1]\npnpm dev',
        kind: 'default-tabs'
      }
    })
    expect(current.container.textContent).not.toContain(
      'Wait for setup to complete before starting agent'
    )

    act(() => current?.root.unmount())
    current?.container.remove()

    current = renderCard({
      advancedOpen: true,
      setupControlsEnabled: true,
      setupConfig: {
        source: 'yaml',
        command: 'pnpm install',
        kind: 'setup'
      }
    })
    expect(current.container.textContent).toContain(
      'Wait for setup to complete before starting agent'
    )
  })

  it('emits the setup startup policy toggle value', () => {
    const changes: string[] = []
    current = renderCard({
      advancedOpen: true,
      setupControlsEnabled: true,
      setupConfig: {
        source: 'yaml',
        command: 'pnpm install',
        kind: 'setup'
      },
      onSetupAgentStartupPolicyChange: (next) => changes.push(next)
    })

    const waitSwitch = current.container.querySelector<HTMLElement>(
      '[role="switch"][aria-label="Wait for setup to complete before starting agent"]'
    )
    expect(waitSwitch).toBeTruthy()
    act(() => waitSwitch?.click())
    expect(changes).toEqual(['wait-for-setup'])
  })

  it('shows a git-only branch name field in Advanced and emits manual edits', () => {
    const changes: (string | undefined)[] = []
    current = renderCard({
      advancedOpen: false,
      branchesEnabled: true,
      branchNameOverride: 'feature/initial',
      onBranchNameOverrideChange: (next) => changes.push(next)
    })

    const branchInput = findInputByLabel(current.container, 'Branch name')
    expect(branchInput).toBeTruthy()
    expect(branchInput?.value).toBe('feature/initial')

    changeInputValue(branchInput as HTMLInputElement, 'feature/manual')

    expect(changes).toEqual(['feature/manual'])
  })

  it('omits the branch name field for non-git projects', () => {
    current = renderCard({
      advancedOpen: true,
      branchesEnabled: true,
      selectedRepoIsGit: false,
      branchNameOverride: 'feature/manual',
      onBranchNameOverrideChange: vi.fn()
    })

    expect(findInputByLabel(current.container, 'Branch name')).toBeNull()
  })

  it('omits the branch name field when a tracked work item is the source', () => {
    // Why: a PR/issue/MR/Linear source derives the branch itself (and a linked
    // GitHub PR re-resolves it at submit), so a manual override would be a
    // silently ignored control — the field is only for typed-name/base-branch.
    current = renderCard({
      advancedOpen: true,
      branchesEnabled: true,
      branchNameOverride: 'feature/manual',
      smartNameSelection: { kind: 'github-pr', label: '#42 Fix', url: 'https://example.com/pr/42' },
      onBranchNameOverrideChange: vi.fn()
    })

    expect(findInputByLabel(current.container, 'Branch name')).toBeNull()
  })

  it('keeps the branch name field when creating from a base branch', () => {
    // Why: choosing a base branch still lets the user name their new branch.
    current = renderCard({
      advancedOpen: true,
      branchesEnabled: true,
      branchNameOverride: 'feature/manual',
      smartNameSelection: { kind: 'branch', label: 'main' },
      onBranchNameOverrideChange: vi.fn()
    })

    expect(findInputByLabel(current.container, 'Branch name')).toBeTruthy()
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

  it('shows VM recipes inside the run target picker', () => {
    const hostChanges: string[] = []
    const recipeChanges: (string | null)[] = []
    current = renderCard({
      projectHostSetupOptions: [
        {
          kind: 'ready',
          id: 'setup-local',
          label: 'Local Mac',
          path: '/Users/alice/orca'
        },
        {
          kind: 'ready',
          id: 'setup-builder',
          label: 'Builder',
          path: '/workspace/orca'
        }
      ] as never,
      selectedProjectHostSetupId: 'setup-local',
      onProjectHostSetupChange: (setupId) => hostChanges.push(setupId),
      ephemeralVmRecipes: [
        {
          id: 'vercel',
          name: 'Vercel Sandbox',
          create: './scripts/orca-vm/vercel.start.sh',
          destroy: './scripts/orca-vm/vercel.cleanup.sh',
          destroyDisabled: false
        }
      ] as never,
      onEphemeralVmRecipeChange: (recipeId) => recipeChanges.push(recipeId)
    })

    expect(current.container.textContent).toContain('Run on')
    expect(current.container.textContent).not.toContain('VM recipe')

    const runTargetButton =
      current.container.querySelector<HTMLButtonElement>('button[role="combobox"]')
    expect(runTargetButton).toBeTruthy()
    act(() => runTargetButton?.click())

    expect(document.body.textContent).toContain('Per-Workspace Environment')
    const ephemeralVmItem = [
      ...document.body.querySelectorAll<HTMLElement>('[role="option"]')
    ].find((item) => item.textContent?.includes('Per-Workspace Environment'))
    expect(ephemeralVmItem).toBeTruthy()
    act(() => ephemeralVmItem?.click())

    const recipeItem = [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
      (item) => item.textContent?.includes('Vercel Sandbox')
    )
    expect(recipeItem).toBeTruthy()
    act(() => recipeItem?.click())

    expect(recipeChanges).toEqual(['vercel'])
    expect(hostChanges).toEqual([])
  })

  it('clears the selected VM recipe when an existing host is selected', () => {
    const hostChanges: string[] = []
    const recipeChanges: (string | null)[] = []
    current = renderCard({
      projectHostSetupOptions: [
        {
          kind: 'ready',
          id: 'setup-local',
          label: 'Local Mac',
          path: '/Users/alice/orca'
        },
        {
          kind: 'ready',
          id: 'setup-builder',
          label: 'Builder',
          path: '/workspace/orca'
        }
      ] as never,
      selectedProjectHostSetupId: 'setup-local',
      onProjectHostSetupChange: (setupId) => hostChanges.push(setupId),
      ephemeralVmRecipes: [
        {
          id: 'vercel',
          name: 'Vercel Sandbox',
          create: './scripts/orca-vm/vercel.start.sh',
          destroyDisabled: true
        }
      ] as never,
      selectedEphemeralVmRecipeId: 'vercel',
      onEphemeralVmRecipeChange: (recipeId) => recipeChanges.push(recipeId)
    })

    const runTargetButton =
      current.container.querySelector<HTMLButtonElement>('button[role="combobox"]')
    expect(runTargetButton?.textContent).toContain('Per-Workspace Environment')
    act(() => runTargetButton?.click())

    const builderItem = [...document.body.querySelectorAll<HTMLElement>('[cmdk-item]')].find(
      (item) => item.textContent?.includes('Builder')
    )
    expect(builderItem).toBeTruthy()
    act(() => builderItem?.click())

    expect(hostChanges).toEqual(['setup-builder'])
    expect(recipeChanges).toEqual([null])
  })
})
