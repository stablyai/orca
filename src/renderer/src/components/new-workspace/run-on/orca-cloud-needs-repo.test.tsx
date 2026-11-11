// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerFooter } from '../NewWorkspaceComposerFooter'
import {
  ORCA_CLOUD_NEEDS_REPO_ID,
  orcaCloudNeedsGitHubRepo,
  type CloudStartView
} from './cloud-start-view'

afterEach(() => {
  cleanup()
})

describe('Orca Cloud on a plain-folder project (RR-c1)', () => {
  it('waits for a GitHub repository only while Orca Cloud is on a folder with none picked', () => {
    const base = { cloudSelected: true, folderProject: true, pickedRepo: false, repoCount: 3 }
    expect(orcaCloudNeedsGitHubRepo(base)).toEqual({ hasRepos: true })
    expect(orcaCloudNeedsGitHubRepo({ ...base, repoCount: 0 })).toEqual({ hasRepos: false })
    // Picking a GitHub repository resolves it; a git project or This computer never needs it.
    expect(orcaCloudNeedsGitHubRepo({ ...base, pickedRepo: true })).toBeNull()
    expect(orcaCloudNeedsGitHubRepo({ ...base, folderProject: false })).toBeNull()
    expect(orcaCloudNeedsGitHubRepo({ ...base, cloudSelected: false })).toBeNull()
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
