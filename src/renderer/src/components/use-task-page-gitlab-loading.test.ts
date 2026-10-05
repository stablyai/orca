// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageProviderMetadataModel } from './use-task-page-provider-metadata'
import { useTaskPageGitLabLoading } from './use-task-page-gitlab-loading'

const listLabels = vi.fn<() => Promise<string[]>>()
const listIssues = vi.fn().mockResolvedValue({ items: [] })
const listMRs = vi.fn().mockResolvedValue({ items: [] })

function repo(id: string): Repo {
  return { id, path: `/workspace/${id}`, displayName: id, badgeColor: '', addedAt: 0 }
}

function createModel() {
  return {
    selectedRepos: [repo('first')],
    selectedReposKey: 'first',
    primaryRepo: repo('first'),
    taskSource: 'gitlab',
    gitlabRefreshNonce: 0,
    gitlabView: 'issues',
    activeGitlabFilter: 'opened',
    selectedGitlabLabels: [],
    setGitlabLabelOptions: vi.fn(),
    setGitlabItems: vi.fn(),
    setGitlabLoading: vi.fn(),
    setGitlabError: vi.fn(),
    setGitlabTodos: vi.fn(),
    setGitlabTodosLoading: vi.fn()
  }
}

function renderLoading(model: ReturnType<typeof createModel>) {
  return renderHook(() =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture contains every field consumed by this hook; earlier pipeline fields are unused.
    useTaskPageGitLabLoading(model as unknown as TaskPageProviderMetadataModel)
  )
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  listLabels.mockResolvedValue(['bug'])
  vi.stubGlobal('api', { gl: { listLabels, listIssues, listMRs } })
})

describe('GitLab label loading scope', () => {
  it('retains labels when switching Issues and MRs in either direction', async () => {
    const model = createModel()
    const { rerender } = renderLoading(model)
    await waitFor(() =>
      expect(model.setGitlabLabelOptions).toHaveBeenLastCalledWith({
        repoKey: 'first',
        labels: ['bug'],
        error: false
      })
    )
    model.setGitlabLabelOptions.mockClear()
    await act(async () => {
      model.gitlabView = 'mrs'
      model.activeGitlabFilter = 'opened'
      rerender()
    })
    await act(async () => {
      model.gitlabView = 'issues'
      model.activeGitlabFilter = 'opened'
      rerender()
    })
    expect(listLabels).toHaveBeenCalledTimes(1)
    expect(model.setGitlabLabelOptions).not.toHaveBeenCalled()
  })

  it('retains an in-flight label request across Issues and MRs', async () => {
    let resolveLabels = (_labels: string[]) => {}
    listLabels.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveLabels = resolve
      })
    )
    const model = createModel()
    const { rerender } = renderLoading(model)
    await act(async () => {
      model.gitlabView = 'mrs'
      model.activeGitlabFilter = 'opened'
      rerender()
    })
    await act(async () => {
      resolveLabels(['original request'])
    })
    expect(model.setGitlabLabelOptions).toHaveBeenLastCalledWith({
      repoKey: 'first',
      labels: ['original request'],
      error: false
    })
    expect(listLabels).toHaveBeenCalledTimes(1)
  })

  it('reloads on repository scope changes and ignores the old result', async () => {
    let resolveOld = (_labels: string[]) => {}
    listLabels.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveOld = resolve
      })
    )
    const model = createModel()
    const { rerender } = renderLoading(model)
    listLabels.mockResolvedValueOnce(['new project'])
    await act(async () => {
      model.selectedRepos = [repo('second')]
      model.selectedReposKey = 'second'
      rerender()
    })
    await waitFor(() =>
      expect(model.setGitlabLabelOptions).toHaveBeenLastCalledWith({
        repoKey: 'second',
        labels: ['new project'],
        error: false
      })
    )
    model.setGitlabLabelOptions.mockClear()
    await act(async () => {
      resolveOld(['old project'])
    })
    expect(model.setGitlabLabelOptions).not.toHaveBeenCalled()
    expect(listLabels).toHaveBeenCalledTimes(2)
    expect(listLabels).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoId: 'second', repoPath: '/workspace/second' })
    )
  })

  it('reloads on explicit refresh and ignores the previous request', async () => {
    let resolveOld = (_labels: string[]) => {}
    listLabels.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveOld = resolve
      })
    )
    const model = createModel()
    const { rerender } = renderLoading(model)
    listLabels.mockResolvedValueOnce(['refreshed'])
    await act(async () => {
      model.gitlabRefreshNonce += 1
      rerender()
    })
    await waitFor(() =>
      expect(model.setGitlabLabelOptions).toHaveBeenLastCalledWith({
        repoKey: 'first',
        labels: ['refreshed'],
        error: false
      })
    )
    model.setGitlabLabelOptions.mockClear()
    await act(async () => {
      resolveOld(['stale'])
    })
    expect(model.setGitlabLabelOptions).not.toHaveBeenCalled()
    expect(listLabels).toHaveBeenCalledTimes(2)
  })
})
