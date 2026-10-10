import { describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  state: {
    settings: { activeRuntimeEnvironmentId: 'focused-runtime' },
    repos: [{ id: 'tracked', connectionId: null, executionHostId: 'runtime:owner-runtime' }]
  }
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))

import { getGitHubMutationTarget } from './github-work-item-edit-mutations'

const projectOrigin = {
  owner: 'acme',
  repo: 'widgets',
  number: 1,
  type: 'issue' as const,
  projectId: 'p',
  projectItemId: 'i',
  cacheKey: 'github-project:runtime:board-runtime:org/acme/1:view'
}

describe('getGitHubMutationTarget', () => {
  it("routes a tracked repo's edit to the repo owner", () => {
    expect(getGitHubMutationTarget('tracked', projectOrigin)).toEqual({
      kind: 'environment',
      environmentId: 'owner-runtime'
    })
  })

  it('sends an untracked Project row to the host that loaded it, not the focused server', () => {
    expect(getGitHubMutationTarget('untracked', projectOrigin)).toEqual({
      kind: 'environment',
      environmentId: 'board-runtime'
    })
  })

  it("uses this computer's credentials for other slug edits with no known repo", () => {
    expect(getGitHubMutationTarget(null, undefined)).toEqual({ kind: 'local' })
  })
})
