// @vitest-environment happy-dom
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeGitRemoteUrl } from '../../../shared/git-remote-identity'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageSourceAvailabilityPreludeModel } from './use-task-page-source-availability'
import { useTaskPageSourceRepoScope } from './use-task-page-source-repo-scope'
import { _resetTaskPageGitLabKnownHostsCache } from './use-task-page-gitlab-known-hosts'
import { useTaskPageGitLabLoading } from './task-page/gitlab/use-task-page-gitlab-loading'

const gl = vi.hoisted(() => ({ knownHosts: vi.fn(), listMRs: vi.fn(), listIssues: vi.fn() }))
vi.mock('@/runtime/gitlab-owner-api', () => ({ gitLabApiFor: () => gl }))

function repoWithOrigin(id: string, remoteUrl: string | null): Repo {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    gitRemoteIdentity: remoteUrl
      ? { canonicalKey: normalizeGitRemoteUrl(remoteUrl) ?? '', remoteName: 'origin', remoteUrl }
      : null
  }
}

const github = repoWithOrigin('github', 'git@github.com:stablyai/orca.git')
const gitlab = repoWithOrigin('gitlab', 'git@gitlab.com:group/project.git')
const selfHosted = repoWithOrigin('self-hosted', 'git@git.example.co.jp:team/api.git')
const noRemote = repoWithOrigin('no-remote', null)
const ids = (repos: readonly Repo[]) => repos.map((repo) => repo.id)

function fixture(
  selectedRepos: Repo[],
  taskSource: 'github' | 'gitlab'
): TaskPageSourceAvailabilityPreludeModel {
  const model = { selectedRepos, taskSource }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook reads only selectedRepos and taskSource.
  return model as unknown as TaskPageSourceAvailabilityPreludeModel
}

beforeEach(() => {
  _resetTaskPageGitLabKnownHostsCache()
  gl.knownHosts.mockReset()
  gl.listMRs.mockReset().mockResolvedValue({ items: [] })
  gl.listIssues.mockReset().mockResolvedValue({ items: [] })
})
afterEach(cleanup)

describe('useTaskPageSourceRepoScope', () => {
  it('asks glab only about a self-hosted origin and keeps it from GitHub until glab answers', async () => {
    let answer: (hosts: string[]) => void = () => {}
    gl.knownHosts.mockReturnValue(new Promise<string[]>((resolve) => (answer = resolve)))
    const model = fixture([github, gitlab, selfHosted, noRemote], 'github')
    const { result } = renderHook(() => useTaskPageSourceRepoScope(model))

    expect(ids(result.current.githubTaskRepos)).toEqual(['github', 'no-remote'])
    expect(ids(result.current.githubExcludedRepos)).toEqual(['gitlab'])
    expect(result.current.githubTaskReposPending).toBe(true)
    expect(gl.knownHosts).toHaveBeenCalledTimes(1)
    expect(gl.knownHosts).toHaveBeenCalledWith(expect.objectContaining({ repoId: 'self-hosted' }))

    answer(['gitlab.com', 'git.example.co.jp'])
    await waitFor(() => expect(result.current.githubTaskReposPending).toBe(false))
    expect(ids(result.current.githubTaskRepos)).toEqual(['github', 'no-remote'])
    expect(ids(result.current.githubExcludedRepos)).toEqual(['gitlab', 'self-hosted'])
  })

  it('queries a repo whose glab lookup failed, and asks again on the next visit', async () => {
    gl.knownHosts.mockRejectedValue(new Error('runtime unreachable'))
    const model = fixture([selfHosted], 'github')
    const first = renderHook(() => useTaskPageSourceRepoScope(model))

    await waitFor(() => expect(ids(first.result.current.githubTaskRepos)).toEqual(['self-hosted']))
    expect(first.result.current.githubTaskReposPending).toBe(false)
    first.unmount()

    renderHook(() => useTaskPageSourceRepoScope(fixture([selfHosted], 'github')))
    await waitFor(() => expect(gl.knownHosts).toHaveBeenCalledTimes(2))
  })

  it("asks each twin row's own glab when a paired server's twins differ only by SSH target", async () => {
    const onServer: Repo = { ...selfHosted, path: '/srv/api', executionHostId: 'runtime:srv' }
    const viaBuilder: Repo = { ...onServer, path: '/builder/api', connectionId: 'builder' }
    gl.knownHosts.mockImplementation(async ({ repoPath }: { repoPath: string }) =>
      repoPath === onServer.path ? ['gitlab.com', 'git.example.co.jp'] : ['gitlab.com']
    )
    const model = fixture([onServer, viaBuilder], 'github')
    const { result } = renderHook(() => useTaskPageSourceRepoScope(model))

    await waitFor(() => expect(result.current.githubTaskReposPending).toBe(false))
    expect(gl.knownHosts).toHaveBeenCalledTimes(2)
    expect(result.current.githubExcludedRepos).toEqual([onServer])
    expect(result.current.githubTaskRepos).toEqual([viaBuilder])
  })

  it('never hands a GitHub origin to glab on the GitLab source', async () => {
    const model = fixture([github, gitlab, selfHosted], 'gitlab')
    const setGitlabItems = vi.fn()
    renderHook(() => {
      const scope = useTaskPageSourceRepoScope(model)
      return useTaskPageGitLabLoading({
        gitlabTaskRepos: scope.gitlabTaskRepos,
        gitlabTaskReposKey: scope.gitlabTaskReposKey,
        gitlabPrimaryRepo: scope.gitlabPrimaryRepo,
        taskSource: 'gitlab',
        setGitlabItems,
        setGitlabLoading: vi.fn(),
        setGitlabError: vi.fn(),
        gitlabRefreshNonce: 0,
        gitlabView: 'mrs',
        setGitlabTodos: vi.fn(),
        setGitlabTodosLoading: vi.fn(),
        activeGitlabFilter: 'opened'
      })
    })

    await waitFor(() => expect(setGitlabItems).toHaveBeenCalled())
    expect(gl.listMRs.mock.calls.map(([args]) => args.repoId)).toEqual(['gitlab', 'self-hosted'])
    expect(gl.knownHosts).not.toHaveBeenCalled()
    expect(model).toMatchObject({ gitlabPrimaryRepo: gitlab })
  })
})
