import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: null,
    settings: {
      defaultTuiAgent: null,
      disabledTuiAgents: [],
      autoRenameBranchFromWork: false
    },
    openModal: vi.fn(),
    updateSettings: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('@/components/repo/RepoCombobox', () => ({
  default: () => <div data-testid="repo-combobox" />
}))

vi.mock('@/components/agent/AgentCombobox', () => ({
  default: () => <div data-testid="agent-combobox" />
}))

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: () => <input aria-label="Workspace name" />,
  type: {}
}))

vi.mock('@/components/new-workspace/AutoRenameBranchHint', () => ({
  default: () => <div data-testid="auto-rename-branch-hint" />
}))

vi.mock('@/components/sparse/SparseCheckoutPresetSelect', () => ({
  default: () => <div data-testid="sparse-checkout-preset-select" />
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

import NewWorkspaceComposerCard from './NewWorkspaceComposerCard'

function renderComposerCard(createInitialCommitPending: boolean): string {
  return renderToStaticMarkup(
    <NewWorkspaceComposerCard
      quickAgent={null}
      onQuickAgentChange={vi.fn()}
      forkPushWarning={null}
      projectError={null}
      eligibleRepos={[
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: '#999999',
          addedAt: 1,
          kind: 'git'
        }
      ]}
      repoId="repo-1"
      selectedProjectId={null}
      projectOptions={[]}
      onProjectChange={vi.fn()}
      selectedRepoIsGit={true}
      onRepoChange={vi.fn()}
      canReuseSelectedBranch={false}
      reuseSelectedBranch={false}
      onReuseSelectedBranchChange={vi.fn()}
      primaryActionLabel="Create workspace"
      name=""
      onNameValueChange={vi.fn()}
      onSmartGitHubItemSelect={vi.fn()}
      onSmartGitLabItemSelect={vi.fn()}
      onSmartBranchSelect={vi.fn()}
      onSmartLinearIssueSelect={vi.fn()}
      smartNameSelection={null}
      onClearSmartNameSelection={vi.fn()}
      detectedAgentIds={null}
      onOpenAgentSettings={vi.fn()}
      advancedOpen={false}
      onToggleAdvanced={vi.fn()}
      createDisabled={false}
      creating={false}
      onCreate={vi.fn()}
      note=""
      onNoteChange={vi.fn()}
      setupConfig={null}
      requiresExplicitSetupChoice={false}
      setupDecision={null}
      onSetupDecisionChange={vi.fn()}
      setupAgentStartupPolicy="start-immediately"
      onSetupAgentStartupPolicyChange={vi.fn()}
      shouldWaitForSetupCheck={false}
      resolvedSetupDecision={null}
      createError={{
        title: 'No base branch found',
        message: 'This repository has no commits yet.',
        action: 'create-initial-commit'
      }}
      createInitialCommitPending={createInitialCommitPending}
      onCreateInitialCommit={vi.fn()}
      selectedRepoConnectionId={null}
      selectedRepoSshStatus={null}
      selectedRepoRequiresConnection={false}
      selectedRepoConnectInProgress={false}
      onConnectSelectedRepo={vi.fn()}
      canUseSparseCheckout={false}
      sparsePresets={[]}
      sparseSelectedPresetId={null}
      onSparseSelectPreset={vi.fn()}
    />
  )
}

describe('NewWorkspaceComposerCard', () => {
  it('disables the create-initial-commit button while the action is pending', () => {
    const markup = renderComposerCard(true)
    const button = markup.match(/<button(?:(?!<\/button>)[\s\S])*Create initial commit[\s\S]*?<\/button>/)?.[0]

    expect(button).toBeDefined()
    expect(button).toContain('disabled=""')
  })

  it('disables the primary create button while the initial commit action is pending', () => {
    const markup = renderComposerCard(true)
    const buttons = markup.match(/<button[^>]*>[\s\S]*?<\/button>/g) ?? []
    const primaryButton = buttons.find((button) => button.includes('Create workspace'))

    expect(primaryButton).toBeDefined()
    expect(primaryButton).toContain('disabled=""')
  })

  it('enables the create-initial-commit button when the action is not pending', () => {
    const markup = renderComposerCard(false)
    const button = markup.match(/<button(?:(?!<\/button>)[\s\S])*Create initial commit[\s\S]*?<\/button>/)?.[0]

    expect(button).toBeDefined()
    expect(button).not.toContain('disabled=""')
  })
})
