import { describe, expect, it } from 'vitest'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import { canReleaseReplayedScrollbackFromStore } from './replayed-scrollback-store-release'

const LOCAL_REPO: RepoConnection = {
  id: 'local-repo',
  connectionId: null,
  executionHostId: 'local'
}
const SSH_REPO: RepoConnection = {
  id: 'ssh-repo',
  connectionId: 'conn-1',
  executionHostId: null
}
const RUNTIME_REPO: RepoConnection = {
  id: 'runtime-repo',
  connectionId: null,
  executionHostId: 'runtime:env-1'
}
const REPOS = [LOCAL_REPO, SSH_REPO, RUNTIME_REPO]

describe('canReleaseReplayedScrollbackFromStore', () => {
  it("releases ref-backed and remote-repo replays but keeps a local worktree's only copy", () => {
    expect(
      canReleaseReplayedScrollbackFromStore({
        hasScrollbackRefs: true,
        worktreeId: 'local-repo::/local/worktree',
        repos: REPOS
      })
    ).toBe(true)
    expect(
      canReleaseReplayedScrollbackFromStore({
        hasScrollbackRefs: false,
        worktreeId: 'ssh-repo::/ssh/worktree',
        repos: REPOS
      })
    ).toBe(true)
    expect(
      canReleaseReplayedScrollbackFromStore({
        hasScrollbackRefs: false,
        worktreeId: 'runtime-repo::/runtime/worktree',
        repos: REPOS
      })
    ).toBe(true)
    expect(
      canReleaseReplayedScrollbackFromStore({
        hasScrollbackRefs: false,
        worktreeId: 'local-repo::/local/worktree',
        repos: REPOS
      })
    ).toBe(false)
  })

  it('releases for an unhydrated repo catalog, matching the capture guard that re-mints it', () => {
    expect(
      canReleaseReplayedScrollbackFromStore({
        hasScrollbackRefs: false,
        worktreeId: 'unknown-repo::/maybe-remote/worktree',
        repos: REPOS
      })
    ).toBe(true)
  })
})
