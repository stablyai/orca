// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

const listing = vi.hoisted(() => {
  const state: { repos: OrcaCloudGitHubRepository[] } = { repos: [] }
  return state
})
vi.mock('@/lib/orca-cloud/use-orca-cloud-github-repositories', () => ({
  invalidateOrcaCloudGitHubRepositories: () => {},
  useOrcaCloudGitHubRepositories: () => ({ repos: listing.repos, showMore: null })
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: { repos: never[] }) => T): T => selector({ repos: [] })
}))
vi.mock('@/lib/orca-cloud/start-cloud-workspace-from-github', () => ({
  startCloudWorkspaceFromGitHub: async () => true
}))

import { useCloudOnlyRepo } from './use-cloud-only-repo'

function repo(fullName: string): OrcaCloudGitHubRepository {
  return { fullName, url: `https://github.com/${fullName}`, private: true }
}

describe('REPO-ACCESS-REFRESH in the composer: a repository picked by hand stays picked', () => {
  beforeEach(() => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { orcaCloudWorkspace: { connectGitHub: vi.fn().mockResolvedValue(undefined) } }
    })
    listing.repos = [repo('acme/api'), repo('acme/docs')]
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  function render() {
    const onAutoPick = vi.fn()
    const hook = renderHook(() =>
      useCloudOnlyRepo({
        repoId: 'r',
        cloudSelected: true,
        cloudOffered: true,
        signedIn: true,
        onAutoPick
      })
    )
    return { hook, onAutoPick }
  }

  it('picks the newly granted repository and Run on follows', () => {
    const { hook, onAutoPick } = render()
    act(() => hook.result.current.moreAccess())
    expect(hook.result.current.githubHandoff).toBe('waiting')
    listing.repos = [...listing.repos, repo('acme/web')]
    hook.rerender()
    expect(hook.result.current.picked?.fullName).toBe('acme/web')
    expect(onAutoPick).toHaveBeenCalledOnce()
    expect(hook.result.current.githubHandoff).toBe('idle')
  })

  it('a hand pick while waiting (one already listed) ends the wait; later grants never replace it', () => {
    const { hook, onAutoPick } = render()
    act(() => hook.result.current.moreAccess())
    act(() => hook.result.current.pick('acme/docs'))
    expect(hook.result.current.githubHandoff).toBe('idle')
    listing.repos = [...listing.repos, repo('acme/web'), repo('acme/www')]
    hook.rerender()
    expect(hook.result.current.picked?.fullName).toBe('acme/docs')
    expect(onAutoPick).not.toHaveBeenCalled()
  })
})
