// One read per workspace, deduped; re-read when forced (the window lapsing).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshCloudGitActor } from './use-cloud-git-actor'

vi.mock('@/store', () => ({ useAppStore: () => null }))
vi.mock('./cloud-workspace-identity', () => ({
  sandboxIdForWorktree: () => null,
  useCloudWorkspaceIdentities: () => null
}))

afterEach(() => vi.unstubAllGlobals())

describe('refreshCloudGitActor', () => {
  it('dedupes reads in flight and within the fresh window; a forced read goes through', async () => {
    const gitActor = vi.fn(async () => ({
      ok: true,
      value: { id: 'sbx_a', githubActing: { actingAs: 'bot', reason: 'window_expired' } }
    }))
    vi.stubGlobal('window', { api: { cloudWorkspaces: { get: gitActor } } })
    await Promise.all([refreshCloudGitActor('sbx_a'), refreshCloudGitActor('sbx_a')])
    await refreshCloudGitActor('sbx_a')
    expect(gitActor).toHaveBeenCalledTimes(1)
    await refreshCloudGitActor('sbx_a', true)
    expect(gitActor).toHaveBeenCalledTimes(2)
  })

  it('a failed read leaves nothing and doesn’t throw', async () => {
    vi.stubGlobal('window', {
      api: { cloudWorkspaces: { get: async () => ({ ok: false, error: 'x' }) } }
    })
    await expect(refreshCloudGitActor('sbx_b')).resolves.toBeUndefined()
  })
})
