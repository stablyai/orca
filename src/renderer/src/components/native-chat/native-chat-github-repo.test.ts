import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { createNativeChatRepoSelector } from './native-chat-github-repo'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'

describe('createNativeChatRepoSelector', () => {
  it('skips the repo scan on unrelated writes and re-resolves when a route input changes', () => {
    const repo = repoFixture({ kind: 'git' })
    let scans = 0
    const repos = [repo]
    const filter = repos.filter.bind(repos)
    Object.defineProperty(repos, 'filter', {
      value: (predicate: Parameters<typeof filter>[0]) => {
        scans++
        return filter(predicate)
      }
    })
    const base = {
      repos,
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo/worktree')] },
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      floatingWorkspacePath: null,
      settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: null }
    }
    const select = createNativeChatRepoSelector('wt-1')

    expect(select(base)).toBe(repo)
    expect(select({ ...base })).toBe(repo)
    expect(scans).toBe(1)

    expect(select({ ...base, worktreesByRepo: {} })).toBeNull()
  })
})
