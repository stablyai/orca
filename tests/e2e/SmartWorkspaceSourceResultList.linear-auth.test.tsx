// @vitest-environment happy-dom
import {
  mocks,
  detailTransport,
  actualSearch,
  pickerStore,
  LinearPicker,
  prepareDefaultPicker
} from './smart-workspace-linear-read-test-fixtures'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { credentialDecryptionMessage } from '../../src/shared/integration-credential-errors'
import { getStatus } from '../../src/main/linear/client'
import { searchIssues } from '../../src/main/linear/linear-issue-lookups'
import { LINEAR_METHODS } from '../../src/main/runtime/rpc/methods/linear'
import { mapDispatcherError } from '../../src/main/runtime/rpc/dispatcher-error-response'
import { successResponse } from '../../src/main/runtime/rpc/errors'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import type { RpcContext } from '../../src/main/runtime/rpc/core'

function installMainRpc(
  status: () => ReturnType<typeof getStatus> | Promise<ReturnType<typeof getStatus>> = getStatus
) {
  const searchMethod = LINEAR_METHODS.find((item) => item.name === 'linear.searchIssues')!
  const statusMethod = LINEAR_METHODS.find((item) => item.name === 'linear.status')!
  const runtime = { linearSearchIssues: searchIssues, linearStatus: status }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these two real RPC methods use only the supplied production search/status methods.
  const context = { runtime } as unknown as RpcContext
  detailTransport.rpc.mockImplementation(async (target, name, params) => {
    expect(target).toEqual({ kind: 'environment', environmentId: 'env-1' })
    const request = { id: 'auth-boundary', authToken: '', method: name, params },
      meta = { runtimeId: 'test' }
    try {
      const result =
        name === 'linear.status'
          ? await statusMethod.handler(undefined, context)
          : await searchMethod.handler(searchMethod.params.parse(params), context)
      return unwrapRuntimeRpcResult(successResponse(request.id, meta, result))
    } catch (error) {
      return unwrapRuntimeRpcResult(mapDispatcherError(request, meta, error))
    }
  })
  mocks.statusReads.mockImplementation((source) => actualSearch.linearStatus(source))
  mocks.state.searchLinearIssues.mockImplementation((query, source, limit, workspaceId) =>
    actualSearch.linearSearchIssues(source, query, limit, workspaceId)
  )
}

it.each(['sdk-auth', 'credential', 'generic'] as const)(
  'real main/RPC/renderer classifies %s safely with scoped account follow-up',
  async (kind) => {
    prepareDefaultPicker({ connected: true, viewer: null, selectedWorkspaceId: 'workspace-1' })
    detailTransport.clear.mockReset()
    const raw =
      kind === 'sdk-auth'
        ? '401 private authentication diagnostic'
        : kind === 'credential'
          ? credentialDecryptionMessage('Linear')
          : '429 private provider diagnostic'
    detailTransport.accountFixture = true
    detailTransport.workspaces = ['workspace-1']
    detailTransport.credential.message = kind === 'credential' ? raw : undefined
    detailTransport.search.mockRejectedValue(
      kind === 'sdk-auth' ? new detailTransport.AuthError(raw) : new Error(raw)
    )
    const oldStatus = Promise.withResolvers<ReturnType<typeof getStatus>>()
    const captured = getStatus()
    let first = kind === 'sdk-auth'
    installMainRpc(() => {
      if (first) {
        first = false
        return oldStatus.promise
      }
      return getStatus()
    })
    const beforeAuth =
      kind === 'sdk-auth' ? pickerStore.getState().checkLinearConnection(true) : undefined
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = mocks.statusReads.mock.calls.length
    const mounted = render(<LinearPicker value="auth-boundary" defaultSource />)
    fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
    if (kind === 'credential') {
      await waitFor(() => expect(screen.getByText('Reconnect Linear')).toBeTruthy())
      expect(
        screen.getAllByText('Unable to read saved Linear login. Reconnect it in Settings.')
      ).toHaveLength(1)
      expect(detailTransport.clear).not.toHaveBeenCalled()
    } else if (kind === 'sdk-auth') {
      await waitFor(() => expect(pickerStore.getState().linearStatus.connected).toBe(false))
      await waitFor(() =>
        expect(screen.getByText('Start typing to create a name or find a source.')).toBeTruthy()
      )
      expect(screen.queryByText('Reconnect Linear')).toBeNull()
      expect(screen.queryByText(raw)).toBeNull()
      expect(detailTransport.clear).toHaveBeenCalledWith('workspace-1')
    } else {
      await waitFor(() =>
        expect(screen.getByText('Unable to load Linear issues. Try again.')).toBeTruthy()
      )
      expect(screen.queryByText(raw)).toBeNull()
      expect(pickerStore.getState().linearStatus.connected).toBe(true)
      expect(detailTransport.clear).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith(
        '[linear] searchIssues failed:',
        expect.objectContaining({ message: raw })
      )
    }
    if (kind === 'sdk-auth') {
      await act(async () => {
        oldStatus.resolve(captured)
        await beforeAuth
      })
      expect(pickerStore.getState().linearStatus.connected).toBe(false)
    }
    if (kind === 'generic') {
      expect(mocks.statusReads.mock.calls.length).toBe(before)
    } else {
      expect(mocks.statusReads.mock.calls.length).toBeGreaterThan(before)
    }
    expect(warn).toHaveBeenCalledWith(
      '[linear] issue read failed:',
      expect.objectContaining({
        message:
          kind === 'credential'
            ? raw
            : kind === 'sdk-auth'
              ? 'Linear authentication expired for this workspace.'
              : 'Unable to load Linear issues. Try again.'
      })
    )
    mounted.unmount()
    warn.mockRestore()
    detailTransport.clear.mockReset()
  }
)

// Disk/token membership and SDK transport are synthetic; account derivation, auth classifier,
// main search, RPC handler/envelope, runtime adapter, owned read and picker are production.
it('sole rejected token updates known account scope even if status fails; ambiguous empty Retry keeps main behavior', async () => {
  detailTransport.accountFixture = true
  detailTransport.workspaces = ['workspace-1']
  prepareDefaultPicker(getStatus())
  detailTransport.search.mockRejectedValue(
    new detailTransport.AuthError('401 private SDK diagnostic')
  )
  installMainRpc(() => {
    throw new Error('status transport unavailable')
  })
  const mounted = render(<LinearPicker value="retry-auth" defaultSource />)
  fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
  await waitFor(() => expect(pickerStore.getState().linearStatus.connected).toBe(false))
  expect(detailTransport.workspaces).toEqual([])
  expect(screen.queryByText('401 private SDK diagnostic')).toBeNull()
  const calls = detailTransport.search.mock.calls.length
  const retry = pickerStore
    .getState()
    .searchLinearIssues('retry-auth', 12, { force: true })
    .acquire()
  await act(async () => {
    expect(await retry.waitForCurrentTerminal()).toMatchObject({ kind: 'data', data: [] })
  })
  expect(detailTransport.search).toHaveBeenCalledTimes(calls)
  expect(pickerStore.getState().linearStatus.connected).toBe(false)
  retry.release()
  mounted.unmount()
})

it('one SDK-rejected workspace cannot erase a healthy partial result when account delivery fails', async () => {
  detailTransport.accountFixture = true
  detailTransport.workspaces = ['workspace-1', 'healthy']
  prepareDefaultPicker({ ...getStatus(), selectedWorkspaceId: 'all' })
  detailTransport.search.mockImplementation(async (_query, _variables, workspace) => {
    if (workspace === 'workspace-1') {
      throw new detailTransport.AuthError('401 private diagnostic')
    }
    return {
      data: {
        searchIssues: {
          nodes: [
            {
              id: 'healthy-row',
              identifier: 'ENG-2',
              title: 'Healthy task',
              updatedAt: '2026-01-01T00:00:00.000Z',
              state: { name: 'Todo', type: 'unstarted', color: '#888' },
              team: { id: 't', key: 'ENG', name: 'Team' },
              labels: { nodes: [] }
            }
          ]
        }
      }
    }
  })
  installMainRpc(() => {
    throw new Error('unreachable')
  })
  render(<LinearPicker value="partial-auth" defaultSource />)
  fireEvent.click(screen.getByRole('button', { name: 'Linear tab' }))
  await waitFor(() => expect(screen.getByText('Healthy task')).toBeTruthy())
  await waitFor(() => expect(mocks.statusReads).toHaveBeenCalled())
  expect(detailTransport.workspaces).toEqual(['healthy'])
  expect(pickerStore.getState().linearStatus.connected).toBe(true)
  // A later successful matching account observation contains the remaining real workspace.
  const beforeReplacement = detailTransport.search.mock.calls.length
  const replacement = Promise.withResolvers<unknown>()
  detailTransport.search.mockReturnValue(replacement.promise)
  // Status I/O keeps the actual aggregate selection while reporting the remaining account.
  installMainRpc(() => ({ ...getStatus(), selectedWorkspaceId: 'all' }))
  await act(async () => {
    await pickerStore.getState().checkLinearConnection(true)
  })
  expect(pickerStore.getState().linearStatus.workspaces?.map((workspace) => workspace.id)).toEqual([
    'healthy'
  ])
  await waitFor(() => expect(detailTransport.search).toHaveBeenCalledTimes(beforeReplacement + 1))
  expect(screen.getByText('Healthy task')).toBeTruthy()
  await act(async () => {
    replacement.resolve({ data: { searchIssues: { nodes: [] } } })
    await replacement.promise
  })
  await waitFor(() => expect(screen.queryByText('Healthy task')).toBeNull())
})
