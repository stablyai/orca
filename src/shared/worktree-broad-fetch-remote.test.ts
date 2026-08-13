import { describe, expect, it } from 'vitest'
import { resolveWorktreeBroadFetchRemoteName } from './worktree-broad-fetch-remote'

describe('resolveWorktreeBroadFetchRemoteName', () => {
  it('falls back to origin when identity is missing or blank', () => {
    expect(resolveWorktreeBroadFetchRemoteName({})).toBe('origin')
    expect(resolveWorktreeBroadFetchRemoteName({ gitRemoteIdentity: null })).toBe('origin')
    expect(
      resolveWorktreeBroadFetchRemoteName({
        gitRemoteIdentity: { remoteName: '   ' }
      })
    ).toBe('origin')
  })

  it('uses the recorded canonical remote name for fork-style clones', () => {
    expect(
      resolveWorktreeBroadFetchRemoteName({
        gitRemoteIdentity: { remoteName: 'upstream' }
      })
    ).toBe('upstream')
  })
})
