// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        closeModal: vi.fn(),
        openModal: vi.fn(),
        openSettingsPage: vi.fn(),
        openSettingsTarget: vi.fn(),
        setRuntimeEnvironmentStatus: vi.fn(),
        activeModal: 'new-workspace-composer',
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

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="workspace name" />
}))

vi.mock('@/components/new-workspace/ProjectCombobox', () => ({
  default: () => <div data-testid="project-combobox" />
}))

// Why: the picker owns its own test; here it only has to report its value and emit picks.
vi.mock('@/components/repo/CreateFromPicker', () => ({
  CreateFromPicker: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (next: string) => void
  }) => (
    <div data-testid="base-ref-picker" data-value={value}>
      <button type="button" onClick={() => onValueChange('release/1.2')}>
        Pick release
      </button>
      <button type="button" onClick={() => onValueChange('')}>
        Pick project default
      </button>
    </div>
  )
}))

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
        repoId="repo-a"
        selectedRepoIsGit
        onRepoChange={() => {}}
        onProjectChange={() => {}}
        primaryActionLabel="Create workspace"
        name=""
        onNameValueChange={() => {}}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={() => {}}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={{ kind: 'jira', label: 'ERP-1491' }}
        onClearSmartNameSelection={() => {}}
        canReuseSelectedBranch={false}
        reuseSelectedBranch={false}
        onReuseSelectedBranchChange={() => {}}
        forkPushWarning={null}
        detectedAgentIds={null}
        onOpenAgentSettings={() => {}}
        advancedOpen={false}
        onToggleAdvanced={() => {}}
        parentWorktreeId={null}
        onParentWorktreeIdChange={() => {}}
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
        baseBranch={undefined}
        onBaseBranchChange={() => {}}
        startFromResetHint={null}
        {...overrides}
      />
    )
  })
  return container
}

function clickButton(container: HTMLDivElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  act(() => button?.click())
}

describe('NewWorkspaceComposerCard start from', () => {
  let container: HTMLDivElement | null = null

  afterEach(() => {
    container?.remove()
    container = null
  })

  it('offers a base ref while a Jira issue names the workspace', () => {
    container = renderCard()

    expect(container.querySelector('[data-testid="base-ref-picker"]')).toBeTruthy()
  })

  it('reports the picked ref to the composer', () => {
    const picks: (string | undefined)[] = []
    container = renderCard({ onBaseBranchChange: (next) => picks.push(next) })

    clickButton(container, 'Pick release')

    expect(picks).toEqual(['release/1.2'])
  })

  it('reports the project default as no base at all', () => {
    const picks: (string | undefined)[] = []
    container = renderCard({
      baseBranch: 'release/1.2',
      onBaseBranchChange: (next) => picks.push(next)
    })

    clickButton(container, 'Pick project default')

    expect(picks).toEqual([undefined])
  })

  // Why: picking a base clears reuse, so offering one here would silently turn a checkout of
  // the picked branch into a new branch off something else.
  it('omits the base ref for a branch source, which already is the base', () => {
    container = renderCard({
      smartNameSelection: { kind: 'branch', label: 'feature/export-v2' },
      baseBranch: 'feature/export-v2'
    })

    expect(container.querySelector('[data-testid="base-ref-picker"]')).toBeNull()
  })

  it('offers the base ref while a plain typed name owns the field', () => {
    container = renderCard({ smartNameSelection: null, name: 'my-own-name' })

    expect(container.querySelector('[data-testid="base-ref-picker"]')).toBeTruthy()
  })

  it.each([
    ['github-pr', { kind: 'github-pr' as const, label: '#42 Fix' }],
    ['gitlab-mr', { kind: 'gitlab-mr' as const, label: '!42 Fix' }]
  ])(
    'omits the base ref for a %s source that carries its own base',
    (_label, smartNameSelection) => {
      container = renderCard({ smartNameSelection })

      expect(container.querySelector('[data-testid="base-ref-picker"]')).toBeNull()
    }
  )

  it('omits the base ref when branches are disabled', () => {
    container = renderCard({ branchesEnabled: false })

    expect(container.querySelector('[data-testid="base-ref-picker"]')).toBeNull()
  })

  it('surfaces the reset hint left by a project switch', () => {
    container = renderCard({ startFromResetHint: 'was origin/main' })

    expect(container.textContent).toContain('was origin/main')
  })
})
