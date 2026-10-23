// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GitLabWorkItem, GitLabWorkItemDetails } from '../../../../shared/gitlab-types'
const ownerRpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: ownerRpc,
  runtimeEnvironmentSupportsCapability: () => Promise.resolve(true)
}))
import { useGitLabItemDetailsEffect } from './use-gitlab-item-dialog-effects'
import { useGitLabItemDialogState } from './use-gitlab-item-dialog-state'
const item: GitLabWorkItem = {
  id: 'one',
  type: 'issue',
  number: 1,
  title: 'Issue',
  state: 'opened',
  url: '',
  labels: [],
  updatedAt: '',
  author: null,
  repoId: 'repo'
}
const cancelWorkItemDetails = vi.fn().mockResolvedValue(undefined)
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const selector = { repoPath: '/repo' }
const details: GitLabWorkItemDetails = {
  item,
  body: '![image](/uploads/secret/image.png)',
  comments: []
}
afterEach(() => {
  cleanup()
  ownerRpc.mockReset()
  cancelWorkItemDetails.mockClear()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('shows text before previews and ignores an old preview after switching items', async () => {
  let finish: (value: GitLabWorkItemDetails) => void = () => {}
  const pending = new Promise<GitLabWorkItemDetails>((resolve) => {
    finish = resolve
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(details)
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ ...details, body: 'New item without images' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gl: { workItemDetails: fetch, cancelWorkItemDetails } }
  })
  const { result, rerender } = renderHook(
    ({ target }) => {
      const state = useGitLabItemDialogState(target.id)
      useGitLabItemDetailsEffect(target, selector, state)
      return state
    },
    { initialProps: { target: item } }
  )
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.details?.body).toBe(details.body)
  expect(fetch).toHaveBeenNthCalledWith(2, {
    ...selector,
    iid: 1,
    type: 'issue',
    includeImages: true,
    requestToken: expect.any(String)
  })
  const requestToken = fetch.mock.calls[1][0].requestToken
  rerender({ target: { ...item, id: 'two', number: 2 } })
  expect(cancelWorkItemDetails).toHaveBeenCalledWith({ requestToken })
  await waitFor(() => expect(result.current.details?.body).toBe('New item without images'))
  await act(async () => finish({ ...details, imageSources: { old: 'data:image/png;base64,abc' } }))
  expect(result.current.details?.imageSources).toBeUndefined()
  expect(fetch).toHaveBeenCalledTimes(3)
})

it.each([false, true])('keeps text when previews settle (failure=%s)', async (failure) => {
  const imageSources = { image: 'data:image/png;base64,abc' }
  const fetch = vi.fn().mockResolvedValueOnce(details)
  if (failure) {
    fetch.mockRejectedValueOnce(new Error('preview timeout'))
  } else {
    fetch.mockResolvedValueOnce({ ...details, body: 'Do not overwrite edited text', imageSources })
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gl: { workItemDetails: fetch, cancelWorkItemDetails } }
  })
  const { result } = renderHook(() => {
    const state = useGitLabItemDialogState(item.id)
    useGitLabItemDetailsEffect(item, selector, state)
    return state
  })
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(result.current.loading).toBe(false))
  expect(result.current.error).toBeNull()
  expect(result.current.details?.body).toBe(details.body)
  expect(result.current.details?.imageSources).toEqual(failure ? undefined : imageSources)
})

it('loads text and previews from the owning server and cancels there on unmount', async () => {
  const localFetch = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gl: { workItemDetails: localFetch, cancelWorkItemDetails } }
  })
  let previewSignal: AbortSignal | undefined
  ownerRpc
    .mockResolvedValueOnce(details)
    .mockImplementationOnce((_target, _method, _params, options) => {
      previewSignal = options.signal
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true
        })
      })
    })
  const serverSelector = {
    ...selector,
    repoId: 'server-repo',
    repoOwnerExecutionHostId: 'runtime:owner-server'
  }
  const { result, unmount } = renderHook(() => {
    const state = useGitLabItemDialogState(item.id)
    useGitLabItemDetailsEffect(item, serverSelector, state)
    return state
  })
  await waitFor(() => expect(ownerRpc).toHaveBeenCalledTimes(2))
  expect(result.current.details?.body).toBe(details.body)
  expect(localFetch).not.toHaveBeenCalled()
  expect(ownerRpc).toHaveBeenLastCalledWith(
    { kind: 'environment', environmentId: 'owner-server' },
    'gitlab.workItemDetails',
    expect.objectContaining({ repo: 'id:server-repo', includeImages: true }),
    expect.objectContaining({ signal: previewSignal })
  )
  unmount()
  expect(previewSignal?.aborted).toBe(true)
  expect(cancelWorkItemDetails).not.toHaveBeenCalled()
})
