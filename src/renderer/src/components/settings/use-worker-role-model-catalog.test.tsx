// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session-wire'
import { AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import { useWorkerRoleModelCatalog } from './use-worker-role-model-catalog'
import {
  readHostModelCatalogSnapshot,
  resetHostModelCatalogSnapshotsForTests
} from '@/runtime/host-model-catalog-snapshots'

const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  capabilities: vi.fn(),
  settings: { activeCodexManagedAccountId: 'work' }
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (...args: unknown[]) => fixture.read(...args)
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  ensureLocalRuntimeCapabilities: () => fixture.capabilities()
}))
vi.mock('@/store', () => ({
  useAppStore: () => fixture.settings
}))

const catalog: AgentSessionModelCatalogResult = {
  origin: 'probe',
  fetchedAt: 1,
  modelsDifferByWorkspace: true,
  models: [
    {
      id: 'new-host-model',
      label: 'New host model',
      isDefault: false,
      efforts: [
        { value: 'low', label: 'Low' },
        { value: 'high', label: 'High' }
      ]
    }
  ]
}

beforeEach(() => {
  resetHostModelCatalogSnapshotsForTests()
  fixture.read.mockReset().mockResolvedValue({ origin: 'unknown' })
  fixture.capabilities.mockResolvedValue([
    AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY
  ])
  fixture.settings = { activeCodexManagedAccountId: 'work' }
})
afterEach(cleanup)

const LOCAL = { kind: 'local' } as const

describe('worker role model catalogs', () => {
  it('uses the actual account reply even when it cannot seed another workspace', async () => {
    fixture.read.mockResolvedValue(catalog)
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() => expect(result.current.catalog?.models[0]?.id).toBe('new-host-model'))
    expect(fixture.read).toHaveBeenCalledExactlyOnceWith(LOCAL, 'agentSession.modelCatalog', {
      agent: 'codex',
      savedOnly: true
    })
    expect(
      readHostModelCatalogSnapshot(LOCAL, 'codex', { newLaunch: false, seedsModel: true })
    ).toBeUndefined()
    expect(result.current.catalog?.models[0]?.options[0]?.kind).toMatchObject({
      type: 'select',
      choices: [{ value: 'low' }, { value: 'high' }]
    })
  })

  it('waits for the live host listing on demand without replacing it with seeds', async () => {
    fixture.read.mockImplementation(async (_target, _method, params) =>
      params.savedOnly
        ? { origin: 'unknown' }
        : params.waitForListing
          ? catalog
          : { origin: 'unknown', listingInProgress: true }
    )
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() => expect(fixture.read).toHaveBeenCalledOnce())
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.catalog?.models[0]?.id).toBe('new-host-model'))
    expect(fixture.read.mock.calls.map(([, , params]) => params)).toEqual([
      { agent: 'codex', savedOnly: true },
      { agent: 'codex' },
      { agent: 'codex', waitForListing: true }
    ])
  })

  it('reports a retrieval failure and recovers on retry', async () => {
    fixture.read.mockRejectedValueOnce(new Error('Host connection closed'))
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() => expect(result.current.error).toBe('Host connection closed'))
    expect(result.current.catalog).toBeNull()
    fixture.read.mockResolvedValue(catalog)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.catalog?.models[0]?.id).toBe('new-host-model'))
    expect(result.current.error).toBeNull()
    expect(result.current.isRefreshing).toBe(false)
  })

  it('retains the host account-unavailability reason without guessed models', async () => {
    fixture.read.mockResolvedValue({
      origin: 'unknown',
      unavailable: { reason: 'notSignedIn', account: 'managed' }
    })
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() =>
      expect(result.current.unavailable).toEqual({ reason: 'notSignedIn', account: 'managed' })
    )
    expect(result.current.catalog).toBeNull()
  })

  it('offers retry after a requested listing completes without model data', async () => {
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBe('Host did not return a model list.'))
    expect(result.current.catalog).toBeNull()
  })

  it('withholds seeds when the host has no saved list or its capabilities are unknown', async () => {
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    expect(result.current.catalog).toBeNull()
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    fixture.capabilities.mockResolvedValueOnce(null)
    act(() => result.current.refresh())
    await waitFor(() => expect(result.current.error).toBeTruthy())
    expect(result.current.catalog).toBeNull()
    expect(fixture.read).toHaveBeenCalledOnce()
  })

  it('keeps existing choices without a listing request on known older hosts', async () => {
    fixture.capabilities.mockResolvedValue([])
    const { result } = renderHook(() => useWorkerRoleModelCatalog('codex'))
    await waitFor(() =>
      expect(result.current.catalog?.models.some((model) => model.id === 'gpt-5.6-sol')).toBe(true)
    )
    expect(fixture.read).not.toHaveBeenCalled()
  })

  it('drops old account choices immediately and ignores its late reply after switching agents', async () => {
    let finish: ((value: AgentSessionModelCatalogResult) => void) | undefined
    fixture.read.mockImplementationOnce(
      () =>
        new Promise<AgentSessionModelCatalogResult>((resolve) => {
          finish = resolve
        })
    )
    const { result, rerender } = renderHook(({ agent }) => useWorkerRoleModelCatalog(agent), {
      initialProps: { agent: 'codex' }
    })
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    rerender({ agent: 'claude' })
    await act(async () => finish?.(catalog))
    expect(result.current.catalog).toBeNull()
    fixture.read.mockResolvedValue(catalog)
    rerender({ agent: 'codex' })
    await waitFor(() => expect(result.current.catalog?.models[0]?.id).toBe('new-host-model'))
    fixture.settings = { activeCodexManagedAccountId: 'personal' }
    fixture.read.mockResolvedValue({ origin: 'unknown' })
    rerender({ agent: 'codex' })
    expect(result.current.catalog).toBeNull()
    await waitFor(() => expect(result.current.isRefreshing).toBe(false))
    expect(result.current.catalog).toBeNull()
  })
})
