// @vitest-environment happy-dom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerFooter } from '../NewWorkspaceComposerFooter'
import {
  ORCA_CLOUD_NEEDS_REPO_ID,
  isGitHubBackedProject,
  orcaCloudNeedsGitHubRepo,
  type CloudStartView
} from './cloud-start-view'
import { useNeedsRepoSubmitGuard } from './use-needs-repo-submit-guard'

afterEach(() => {
  cleanup()
})

describe('Orca Cloud on a plain-folder project (RR-c1)', () => {
  it('waits for a GitHub repository only while Orca Cloud is on a folder with none picked', () => {
    const base = {
      cloudSelected: true,
      folderProject: true,
      pickedRepo: false,
      repoCount: 3,
      githubProjectCount: 0
    }
    expect(orcaCloudNeedsGitHubRepo(base)).toEqual({ hasRepos: true })
    expect(orcaCloudNeedsGitHubRepo({ ...base, repoCount: 0 })).toEqual({ hasRepos: false })
    // A GitHub project already added (Hello-World in the sidebar) is a repository to choose too.
    expect(orcaCloudNeedsGitHubRepo({ ...base, repoCount: 0, githubProjectCount: 1 })).toEqual({
      hasRepos: true
    })
    // Picking a GitHub repository resolves it; a git project or This computer never needs it.
    expect(orcaCloudNeedsGitHubRepo({ ...base, pickedRepo: true })).toBeNull()
    expect(orcaCloudNeedsGitHubRepo({ ...base, folderProject: false })).toBeNull()
    expect(orcaCloudNeedsGitHubRepo({ ...base, cloudSelected: false })).toBeNull()
  })

  it('counts git projects with a GitHub remote, or one not read yet; never folders or other hosts', () => {
    expect(isGitHubBackedProject({ kind: 'folder' })).toBe(false)
    expect(isGitHubBackedProject({ kind: 'git' })).toBe(true)
    expect(
      isGitHubBackedProject({
        kind: 'git',
        gitRemoteIdentity: { remoteUrl: 'https://github.com/octocat/Hello-World.git' }
      })
    ).toBe(true)
    expect(
      isGitHubBackedProject({
        kind: 'git',
        gitRemoteIdentity: { remoteUrl: 'git@github.com:octocat/Hello-World.git' }
      })
    ).toBe(true)
    expect(
      isGitHubBackedProject({
        kind: 'git',
        gitRemoteIdentity: { remoteUrl: 'https://gitlab.com/acme/app.git' }
      })
    ).toBe(false)
  })

  it('Create stays enabled and silent until pressed; then it points at the error', () => {
    const onCreate = vi.fn()
    const footer = (needsGitHubRepo: CloudStartView['needsGitHubRepo']) => (
      <NewWorkspaceComposerFooter
        onCreate={onCreate}
        createError={null}
        createDisabled={false}
        creating={false}
        primaryActionLabel="Create workspace"
        submitShortcutModifierLabel="⌘"
        cloudStart={{ onSelectOrcaCloud: () => {}, onUserPick: () => {}, needsGitHubRepo }}
      />
    )
    const { getByRole, rerender } = render(footer(null))
    const button = getByRole('button', { name: /Create workspace/ })
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-describedby')).toBeNull()
    rerender(footer({ hasRepos: true, attempt: 1 }))
    expect(button).toHaveProperty('disabled', false)
    expect(button.getAttribute('aria-describedby')).toBe(ORCA_CLOUD_NEEDS_REPO_ID)
  })
})

describe('RR-c1 submit-time validation (useNeedsRepoSubmitGuard)', () => {
  it('before Create: no error; Create (button or ⌘↵, one handler) never submits; the error shows', () => {
    const submit = vi.fn()
    const { result } = renderHook(() => useNeedsRepoSubmitGuard({ hasRepos: true }, submit))
    expect(result.current.shown).toBeNull()
    act(() => result.current.onPrimary())
    expect(submit).not.toHaveBeenCalled()
    expect(result.current.shown).toEqual({ hasRepos: true, attempt: 1 })
    // Each stopped Create counts, so focus moves to Project each time.
    act(() => result.current.onPrimary())
    expect(result.current.shown?.attempt).toBe(2)
  })

  it('clears once a GitHub repository is picked or Run on leaves Orca Cloud, then submits', () => {
    const submit = vi.fn()
    const needs = { hasRepos: false }
    const initialProps: { needsRepo: { hasRepos: boolean } | null } = { needsRepo: needs }
    const { result, rerender } = renderHook(
      ({ needsRepo }) => useNeedsRepoSubmitGuard(needsRepo, submit),
      { initialProps }
    )
    act(() => result.current.onPrimary())
    expect(result.current.shown).not.toBeNull()
    rerender({ needsRepo: null })
    expect(result.current.shown).toBeNull()
    act(() => result.current.onPrimary())
    expect(submit).toHaveBeenCalledTimes(1)
    // Back on a folder: silent again until the next Create.
    rerender({ needsRepo: needs })
    expect(result.current.shown).toBeNull()
  })
})
