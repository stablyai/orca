// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'
import type { EphemeralVmRecipeOption } from '../run-target/run-target-options'

vi.mock('@/components/new-workspace/SmartWorkspaceNameField', () => ({
  default: ({ value, selectedSource }: { value: string; selectedSource?: { label: string } }) => (
    <div>
      <span>{selectedSource?.label}</span>
      <input aria-label="Workspace name" value={value} readOnly />
    </div>
  )
}))

function branchProps(): React.ComponentProps<typeof NewWorkspaceComposerNameSection> {
  return {
    eligibleRepos: [],
    repoId: 'repo',
    onRepoChange: vi.fn(),
    name: 'Payments review',
    onNameValueChange: vi.fn(),
    onSmartGitHubItemSelect: vi.fn(),
    onSmartGitLabItemSelect: vi.fn(),
    onSmartBranchSelect: vi.fn(),
    onSmartLinearIssueSelect: vi.fn(),
    smartNameSelection: { kind: 'branch', label: 'origin/feature/payments' },
    onClearSmartNameSelection: vi.fn(),
    selectedRepoRequiresConnection: false,
    selectedRepoIsGit: true,
    branchesEnabled: true,
    forkPushWarning: null,
    canReuseSelectedBranch: true,
    reuseEligibleBranch: 'feature/payments',
    branchNameOverride: undefined,
    onBranchNameOverrideChange: vi.fn(),
    reuseSelectedBranch: true,
    onReuseSelectedBranchChange: vi.fn(),
    baseBranch: 'refs/remotes/origin/feature/payments',
    onNamePlainEnter: vi.fn()
  }
}

afterEach(cleanup)

describe('NewWorkspaceComposerNameSection branch choice title', () => {
  it('titles the branch choice for a workspace only when Run on is Orca Cloud (JA-25)', () => {
    const props = branchProps()
    const cloudRecipe: EphemeralVmRecipeOption = {
      id: 'cloud',
      name: 'Orca Cloud',
      description: 'Hosted by Orca.',
      provider: 'orca-cloud',
      create: 'orca-cloud create'
    }
    const localRecipe: EphemeralVmRecipeOption = { id: 'vm', name: 'My VM', create: './vm up' }
    const { rerender } = render(<NewWorkspaceComposerNameSection {...props} />)
    expect(screen.getByRole('radiogroup', { name: 'Branch for this worktree' })).toBeTruthy()

    rerender(
      <NewWorkspaceComposerNameSection
        {...props}
        ephemeralVmRecipes={[cloudRecipe, localRecipe]}
        selectedEphemeralVmRecipeId="vm"
      />
    )
    expect(screen.getByRole('radiogroup', { name: 'Branch for this worktree' })).toBeTruthy()
    expect(screen.getByText('Create a new local branch')).toBeTruthy()

    rerender(
      <NewWorkspaceComposerNameSection
        {...props}
        ephemeralVmRecipes={[cloudRecipe, localRecipe]}
        selectedEphemeralVmRecipeId="cloud"
      />
    )
    expect(screen.getByRole('radiogroup', { name: 'Branch for this workspace' })).toBeTruthy()
    expect(screen.getByText('Branch for this workspace')).toBeTruthy()
    expect(screen.queryByText('Branch for this worktree')).toBeNull()
    // The branch lives in the sandbox, not on this computer.
    expect(screen.getByText('Create a new branch.')).toBeTruthy()
    expect(screen.queryByText('Create a new local branch')).toBeNull()
  })
})
