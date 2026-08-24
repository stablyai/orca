import { describe, expect, it } from 'vitest'
import {
  buildWorkspaceInstanceWorktreeId,
  getProjectCheckoutWorktreeId,
  getWorkspaceInstanceIdentity,
  isTerminalGroupWorktreeId,
  isWorkspaceInstanceWorktreeIdForRepo,
  sharesProjectCheckout
} from './workspace-instance-worktree'
import { isWorkspaceInstanceWorktreeId } from './worktree/id'

const UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const gitRepo = { id: 'repo-1', path: '/workspace/repo', kind: 'git' as const }
const folderRepo = { id: 'repo-2', path: '/workspace/folder', kind: 'folder' as const }

describe('workspace instance ids', () => {
  it('builds an instance id under the project checkout row', () => {
    expect(getProjectCheckoutWorktreeId(gitRepo)).toBe('repo-1::/workspace/repo')
    expect(buildWorkspaceInstanceWorktreeId(gitRepo, UUID)).toBe(
      `repo-1::/workspace/repo::workspace:${UUID}`
    )
  })

  it('recognizes only the uuid-suffixed shape', () => {
    expect(isWorkspaceInstanceWorktreeId(buildWorkspaceInstanceWorktreeId(gitRepo, UUID))).toBe(
      true
    )
    expect(isWorkspaceInstanceWorktreeId('repo-1::/workspace/repo')).toBe(false)
    // A directory literally named `::workspace:not-a-uuid` must not read as an instance.
    expect(isWorkspaceInstanceWorktreeId('repo-1::/workspace/repo::workspace:nope')).toBe(false)
  })

  it('scopes instance ids to the owning repo and checkout path', () => {
    const id = buildWorkspaceInstanceWorktreeId(gitRepo, UUID)
    expect(isWorkspaceInstanceWorktreeIdForRepo(gitRepo, id)).toBe(true)
    expect(isWorkspaceInstanceWorktreeIdForRepo(folderRepo, id)).toBe(false)
    expect(
      isWorkspaceInstanceWorktreeIdForRepo({ id: 'repo-1', path: '/workspace/other' }, id)
    ).toBe(false)
  })

  it('extracts the instance identity, or null for a foreign id', () => {
    expect(
      getWorkspaceInstanceIdentity(gitRepo, buildWorkspaceInstanceWorktreeId(gitRepo, UUID))
    ).toBe(UUID)
    expect(getWorkspaceInstanceIdentity(gitRepo, 'repo-1::/workspace/repo')).toBeNull()
  })
})

describe('sharesProjectCheckout', () => {
  it('covers every folder-project workspace', () => {
    expect(sharesProjectCheckout(folderRepo, getProjectCheckoutWorktreeId(folderRepo))).toBe(true)
    expect(
      sharesProjectCheckout(folderRepo, buildWorkspaceInstanceWorktreeId(folderRepo, UUID))
    ).toBe(true)
  })

  it('covers a git project only for its terminal groups', () => {
    expect(sharesProjectCheckout(gitRepo, getProjectCheckoutWorktreeId(gitRepo))).toBe(false)
    expect(sharesProjectCheckout(gitRepo, buildWorkspaceInstanceWorktreeId(gitRepo, UUID))).toBe(
      true
    )
  })

  it('falls back to the id shape when the repo row is unknown', () => {
    expect(sharesProjectCheckout(null, buildWorkspaceInstanceWorktreeId(gitRepo, UUID))).toBe(true)
    expect(sharesProjectCheckout(null, 'repo-1::/workspace/repo')).toBe(false)
    expect(sharesProjectCheckout(null, null)).toBe(false)
  })
})

describe('isTerminalGroupWorktreeId', () => {
  it('names the git-project case only — a folder project calls the same shape a workspace', () => {
    const gitInstance = buildWorkspaceInstanceWorktreeId(gitRepo, UUID)
    const folderInstance = buildWorkspaceInstanceWorktreeId(folderRepo, UUID)
    expect(isTerminalGroupWorktreeId(gitRepo, gitInstance)).toBe(true)
    expect(isTerminalGroupWorktreeId(folderRepo, folderInstance)).toBe(false)
    expect(isTerminalGroupWorktreeId(gitRepo, getProjectCheckoutWorktreeId(gitRepo))).toBe(false)
  })
})
