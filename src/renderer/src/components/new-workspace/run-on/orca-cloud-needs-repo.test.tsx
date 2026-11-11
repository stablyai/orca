// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerFooter } from '../NewWorkspaceComposerFooter'
import {
  ORCA_CLOUD_NEEDS_REPO_ID,
  isGitHubBackedProject,
  orcaCloudNeedsGitHubRepo,
  type CloudStartView
} from './cloud-start-view'

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

  it('Create is disabled and says why, so it never fails after a click', () => {
    const onCreate = vi.fn()
    const cloudStart: CloudStartView = {
      onSelectOrcaCloud: () => {},
      onUserPick: () => {},
      needsGitHubRepo: { hasRepos: true }
    }
    const { getByRole } = render(
      <NewWorkspaceComposerFooter
        onCreate={onCreate}
        createError={null}
        createDisabled
        creating={false}
        primaryActionLabel="Create workspace"
        submitShortcutModifierLabel="⌘"
        cloudStart={cloudStart}
      />
    )
    const button = getByRole('button', { name: /Create workspace/ })
    expect(button).toHaveProperty('disabled', true)
    expect(button.getAttribute('aria-describedby')).toBe(ORCA_CLOUD_NEEDS_REPO_ID)
    expect(button.parentElement?.getAttribute('title')).toBe(
      'Orca Cloud needs a GitHub repository.'
    )
    button.click()
    expect(onCreate).not.toHaveBeenCalled()
  })
})
