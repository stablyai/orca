// @vitest-environment happy-dom
// UNREACHABLE-REPO-NO-ROUTE: Orca Cloud on a GitHub project cloned only on a remote server, whose
// repository the team's GitHub access doesn't cover. Create waits, and the line under Project says
// why (not the folder wording) with More access; the Project picker lists repositories to pick.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { orcaCloudNeedsGitHubRepo } from './cloud-start-view'
import { OrcaCloudNeedsRepoLine } from './OrcaCloudNeedsRepoLine'

afterEach(cleanup)

const base = {
  cloudSelected: true,
  folderProject: true,
  pickedRepo: false,
  repoCount: 2,
  githubProjectCount: 1
}

describe('unreachable repository on a remote-server project', () => {
  it('marks the wait as unreachable only for a remote-server project', () => {
    expect(orcaCloudNeedsGitHubRepo({ ...base, remoteServerProject: true })).toEqual({
      hasRepos: true,
      unreachable: true
    })
    expect(orcaCloudNeedsGitHubRepo(base)).toEqual({ hasRepos: true })
    // Reachable (auto-picked): nothing waits.
    expect(
      orcaCloudNeedsGitHubRepo({ ...base, remoteServerProject: true, pickedRepo: true })
    ).toBeNull()
  })

  it('says Orca Cloud cannot reach the repository and offers Give Orca access, in a muted tone', () => {
    const onMoreAccess = vi.fn()
    render(
      <OrcaCloudNeedsRepoLine
        hasRepos
        onAddRepository={() => {}}
        unreachable
        onMoreAccess={onMoreAccess}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain('can’t reach this project’s')
    expect(screen.queryByText('Orca Cloud needs a GitHub repository.')).toBeNull()
    // A fixable access precondition, not an error: never red.
    expect(screen.getByRole('alert').querySelector('p')?.className).not.toContain('destructive')
    fireEvent.click(screen.getByRole('button', { name: 'Give Orca access' }))
    expect(onMoreAccess).toHaveBeenCalledTimes(1)
  })

  it('a folder keeps its own wording', () => {
    render(<OrcaCloudNeedsRepoLine hasRepos onAddRepository={() => {}} />)
    expect(screen.getByRole('alert').textContent).toBe('Orca Cloud needs a GitHub repository.')
  })
})
