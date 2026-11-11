// @vitest-environment happy-dom

import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'
import type { EphemeralVmRecipeOption } from './run-target-options'

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

describe('NewWorkspaceComposerNameSection branch reuse', () => {
  it('chooses a new branch by pointer and the existing branch by keyboard without changing the source', async () => {
    const user = userEvent.setup()
    const props = branchProps()
    const { rerender } = render(<NewWorkspaceComposerNameSection {...props} />)

    expect(screen.getByText('origin/feature/payments')).toBeTruthy()
    expect(screen.getByText('feature/payments')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'New branch name' })).toBeNull()
    expect(
      screen.getByRole('radio', { name: 'Existing branch' }).getAttribute('aria-checked')
    ).toBe('true')
    await user.click(screen.getByRole('radio', { name: 'New branch' }))
    expect(props.onReuseSelectedBranchChange).toHaveBeenLastCalledWith(false)

    rerender(<NewWorkspaceComposerNameSection {...props} reuseSelectedBranch={false} />)
    expect(
      screen.getByRole('radio', { name: 'Existing branch' }).getAttribute('aria-checked')
    ).toBe('false')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New branch name' }))
    await user.paste('review/payments')
    expect(props.onBranchNameOverrideChange).toHaveBeenLastCalledWith('review/payments')
    await user.click(screen.getByRole('radio', { name: 'New branch' }))
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New branch name' }))
    screen.getByRole('radio', { name: 'New branch' }).focus()
    await user.keyboard('{ArrowUp>}')
    await waitFor(() => expect(props.onReuseSelectedBranchChange).toHaveBeenLastCalledWith(true))
    await user.keyboard('{/ArrowUp}')
    expect(props.onNameValueChange).not.toHaveBeenCalled()
    expect(props.onClearSmartNameSelection).not.toHaveBeenCalled()
  })

  it('opens the existing workspace with the keyboard without submitting or changing branch intent', async () => {
    const user = userEvent.setup()
    const props = branchProps()
    const openWorkspace = vi.fn()
    const submit = vi.fn((event: React.FormEvent) => event.preventDefault())
    render(
      <form onSubmit={submit}>
        <NewWorkspaceComposerNameSection {...props} onOpenSelectedBranchWorkspace={openWorkspace} />
      </form>
    )

    const openButton = screen.getByRole('button', { name: 'Open existing workspace' })
    await user.tab()
    await user.tab()
    await user.tab()
    expect(document.activeElement).toBe(openButton)
    await user.keyboard('{Enter}')

    expect(openWorkspace).toHaveBeenCalledOnce()
    expect(submit).not.toHaveBeenCalled()
    expect(props.onReuseSelectedBranchChange).not.toHaveBeenCalled()
    expect(props.onNameValueChange).not.toHaveBeenCalled()
    expect(props.onClearSmartNameSelection).not.toHaveBeenCalled()
  })

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
  })
})
