// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GiteaWorkspaceSelection } from './GiteaIssueWorkspace'
import type { GiteaComment } from '../../../shared/gitea-types'
import { useGiteaPrResources } from './use-gitea-pr-resources'

const mocks = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
const selection: GiteaWorkspaceSelection = {
  repo: { id: 'repo', path: '/repo', displayName: 'Gitea', badgeColor: '', addedAt: 0 },
  scope: { repoId: 'repo', repoPath: '/repo' },
  item: {
    id: 7,
    number: 7,
    type: 'pull',
    title: 'Review',
    state: 'open',
    url: '',
    repoOwner: 'team',
    repoName: 'app',
    labels: [],
    comments: 0,
    createdAt: '',
    updatedAt: ''
  }
}

function installApi() {
  const api = {
    prDetail: vi.fn().mockResolvedValue({ number: 7, body: 'Description', headSha: 'abc' }),
    prFiles: vi.fn().mockResolvedValue([{ path: 'file.ts', status: 'modified' }]),
    issueComments: vi
      .fn()
      .mockResolvedValue([{ id: 1, body: 'Existing comment', user: { login: 'author' } }]),
    prReviewComments: vi.fn().mockResolvedValue([]),
    prChecks: vi.fn().mockResolvedValue([{ context: 'test', state: 'success' }])
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { gitea: api } })
  return api
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Gitea PR resource loading', () => {
  it('preserves the PR, conversation, and checks when file loading fails', async () => {
    const api = installApi()
    api.prFiles.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() => useGiteaPrResources(selection))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.detail?.body).toBe('Description')
    expect(result.current.comments[0]?.user?.login).toBe('author')
    expect(result.current.checks[0]?.context).toBe('test')
    expect(result.current.files).toEqual([])
    expect(mocks.error).toHaveBeenCalled()
  })

  it('does not replace a new selection with an older response', async () => {
    const api = installApi()
    let complete: (comments: GiteaComment[]) => void = () => {}
    api.issueComments.mockImplementationOnce(
      () =>
        new Promise<GiteaComment[]>((resolve) => {
          complete = resolve
        })
    )
    const { result, rerender } = renderHook(({ current }) => useGiteaPrResources(current), {
      initialProps: { current: selection }
    })
    rerender({ current: { ...selection, item: { ...selection.item, number: 8 } } })
    await waitFor(() => expect(result.current.loading).toBe(false))
    await act(async () => {
      complete([{ id: 2, body: 'Stale comment', createdAt: '' }])
    })
    expect(result.current.comments[0]?.body).toBe('Existing comment')
  })
})
