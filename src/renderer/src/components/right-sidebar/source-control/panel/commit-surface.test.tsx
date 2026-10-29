// @vitest-environment happy-dom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SourceControlCommitSurface } from './commit-surface'
import type { SourceControlCommitSurfaceProps } from './commit-surface'

// The surface reads a slice of the panel model; the cast keeps the stub to the fields render touches.
function renderSurface(model: Record<string, unknown>): SourceControlCommitSurfaceProps {
  const props = {
    activeRepo: { id: 'repo-1' },
    activeWorktree: null,
    currentWorktreeId: 'wt-1',
    worktreePath: '/repo',
    model
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: render reads only the stubbed fields, never the full panel model.
  return props as unknown as SourceControlCommitSurfaceProps
}

describe('SourceControlCommitSurface', () => {
  it('keeps the message composer reachable on a clean tree so clean commits can be reworded', () => {
    const model = {
      activeWorktreeId: 'wt-1',
      activeGroupId: null,
      activeConnectionId: null,
      activeSourceControlLaunchPlatform: null,
      branchName: 'main',
      commitMessage: '',
      commitError: null,
      commitFailureRecoveryPrompt: null,
      pushRecovery: null,
      remoteActionError: null,
      createPrIntentNotice: null,
      directCreatePrAction: null,
      dropdownItems: [],
      generateError: null,
      getLaunchActionRecipe: () => null,
      grouped: { staged: [], unstaged: [], untracked: [] },
      handleActionInvoke: vi.fn(),
      handleCancelGenerate: vi.fn(),
      handleCancelGeneratePullRequestFields: vi.fn(),
      handleCreatePullRequest: vi.fn(),
      handleFixCommitFailureWithAI: vi.fn(),
      handleFixPushFailureWithAI: vi.fn(),
      handleGenerateCommitMessageClick: vi.fn(),
      handleGeneratePullRequestFieldsClick: vi.fn(),
      handlePrimaryClick: vi.fn(),
      hasPartiallyStagedChanges: false,
      inFlightRemoteOpKind: null,
      isAbortingOperation: false,
      isCommitting: false,
      isCreatePrIntentInFlight: false,
      isCreatingPr: false,
      isGenerating: false,
      isRemoteOperationActive: false,
      openSourceControlAiSettings: vi.fn(),
      primaryAction: { kind: 'commit', label: 'Commit', title: '', disabled: true },
      resolvedCommitMessageAi: null,
      saveLaunchActionDefault: vi.fn(),
      sourceControlAiActionsVisible: false,
      unresolvedConflicts: [],
      updateCommitDrafts: vi.fn()
    }

    const { container } = render(
      <TooltipProvider>
        <SourceControlCommitSurface {...renderSurface(model)} />
      </TooltipProvider>
    )

    expect(container.querySelector('textarea')).not.toBeNull()
  })
})
