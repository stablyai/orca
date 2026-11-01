import { beforeEach, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getWorkspaceReferenceRequest } from '@/components/sidebar/workspace-reference-details'
import {
  createTestStore,
  makePRRefreshWorktree,
  mockApi,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from '../slices/github-slice-test-harness'
import { getVisibleHostedReviewRefreshTargets } from './visible-hosted-review-refresh-targets'

const owner: Repo = { id: 'repo-1', path: '/repo', displayName: 'repo', badgeColor: '', addedAt: 0 }
const providers = [
  ['github', 'linkedPR', 'github.com/team/repo', 'pull'],
  ['gitlab', 'linkedGitLabMR', 'gitlab.example.com/team/repo', '-/merge_requests'],
  ['bitbucket', 'linkedBitbucketPR', 'bitbucket.org/team/repo', 'pull-requests'],
  ['azure-devops', 'linkedAzureDevOpsPR', 'dev.azure.com/team/project/_git/repo', 'pullrequest'],
  ['gitea', 'linkedGiteaPR', 'codeberg.org/team/repo', 'pulls']
] as const

beforeEach(() => {
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
  mockApi.hostedReview.forBranch.mockResolvedValue(null)
})

it.each(providers)(
  'loads exact detached %s reviews without branch discovery or cache collisions',
  async (provider, slot, canonicalKey, route) => {
    const repo: Repo = {
      ...owner,
      gitRemoteIdentity: {
        canonicalKey,
        remoteName: 'origin',
        remoteUrl: `https://${canonicalKey}.git`
      }
    }
    const items = [8, 9].map((number) => ({
      provider,
      type: provider === 'gitlab' ? ('mr' as const) : ('pr' as const),
      number,
      url: `https://${canonicalKey}/${route}/${number}`
    }))
    const workspaces = items.map((item) =>
      makePRRefreshWorktree({
        id: `detached-${item.number}`,
        branch: '',
        [slot]: item.number,
        linkedItems: [item]
      })
    )
    const store = createTestStore()
    store.setState({
      repos: [repo],
      settings: null,
      worktreesByRepo: { [repo.id]: workspaces },
      activeWorktreeId: null,
      visibleReviewWorktreeIds: workspaces.map((workspace) => workspace.id),
      sshConnectionStates: new Map()
    })
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState)
    expect(targets).toHaveLength(2)
    expect(new Set(targets.map((target) => target.key)).size).toBe(2)
    await Promise.all(targets.map((target) => target.refresh()))
    for (const [index, workspace] of workspaces.entries()) {
      const key = getWorkspaceReferenceRequest(items[index], workspace, repo).key
      expect(store.getState().hostedReviewCache[key]?.data).toBeNull()
    }
    expect(mockApi.hostedReview.forBranch).toHaveBeenCalledTimes(2)
    expect(mockApi.gh.prForBranch).not.toHaveBeenCalled()
  }
)

it.each(['runtime:owner-server', 'ssh:owner-server'] as const)(
  'retains %s ownership while focus names another server',
  async (executionHostId) => {
    const repo: Repo = {
      ...owner,
      executionHostId,
      ...(executionHostId.startsWith('ssh:') ? { connectionId: 'owner-server' } : {}),
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/team/repo',
        remoteName: 'origin',
        remoteUrl: 'https://gitlab.com/team/repo.git'
      }
    }
    const workspace = makePRRefreshWorktree({ branch: '', linkedGitLabMR: 8 })
    const store = createTestStore()
    store.setState({
      repos: [repo],
      settings: createGlobalSettingsFixture({ activeRuntimeEnvironmentId: 'other-server' }),
      worktreesByRepo: { [repo.id]: [workspace] },
      visibleReviewWorktreeIds: [workspace.id],
      activeWorktreeId: workspace.id,
      sshConnectionStates: new Map([
        [
          'owner-server',
          { targetId: 'owner-server', status: 'connected', error: null, reconnectAttempt: 0 }
        ]
      ])
    })
    runtimeEnvironmentCall.mockResolvedValue({ id: 'review', ok: true, result: null })
    const targets = getVisibleHostedReviewRefreshTargets(store.getState(), store.getState, {
      selectedOnly: true
    })
    expect(targets).toHaveLength(1)
    await targets[0].refresh()
    if (executionHostId.startsWith('runtime:')) {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'owner-server',
          method: 'hostedReview.forBranch',
          params: expect.objectContaining({ branch: '', linkedGitLabMR: 8 })
        })
      )
      expect(mockApi.hostedReview.forBranch).not.toHaveBeenCalled()
    } else {
      expect(mockApi.hostedReview.forBranch).toHaveBeenCalledWith(
        expect.objectContaining({ repoOwnerExecutionHostId: executionHostId })
      )
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    }
  }
)
