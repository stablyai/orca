// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/remote-runtime/protocol/protocol-version'
import {
  checkCloudRuntimeSkew,
  resetCloudRuntimeSkewForTests,
  useCloudRuntimeSkew
} from './use-cloud-runtime-skew'

const owner = vi.hoisted(() => {
  const state: { environmentId: string | null } = { environmentId: 'env-1' }
  return state
})
vi.mock('@/lib/workspace/ownership/resolve-owner', () => ({
  runtimeEnvironmentIdForWorkspaceOwner: () => ({
    kind: 'resolved',
    environmentId: owner.environmentId
  })
}))

const call = vi.fn()
const IN_RANGE = {
  runtimeId: 'rt',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}
const NEWER = { runtimeId: 'rt', runtimeProtocolVersion: 99, minCompatibleRuntimeClientVersion: 99 }
const OLDER = { runtimeId: 'rt', runtimeProtocolVersion: 0, minCompatibleRuntimeClientVersion: 0 }

function ok(result: Record<string, unknown>): unknown {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}

beforeEach(() => {
  call.mockReset()
  owner.environmentId = 'env-1'
  Object.assign(window, { api: { runtimeEnvironments: { call } } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetCloudRuntimeSkewForTests()
  vi.restoreAllMocks()
})

describe('checkCloudRuntimeSkew', () => {
  it('reads status.get once, shares a call in flight, and reuses the answer', async () => {
    call.mockResolvedValue(ok(IN_RANGE))
    const [a, b] = await Promise.all([
      checkCloudRuntimeSkew('env-1'),
      checkCloudRuntimeSkew('env-1')
    ])
    expect(a).toEqual({ kind: 'compatible' })
    expect(b).toEqual({ kind: 'compatible' })
    await checkCloudRuntimeSkew('env-1')
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0][0]).toMatchObject({ selector: 'env-1', method: 'status.get' })
  })

  it('asks again once the answer is older than 30 minutes', async () => {
    call.mockResolvedValue(ok(IN_RANGE))
    await checkCloudRuntimeSkew('env-1')
    await checkCloudRuntimeSkew('env-1', Date.now() + 31 * 60_000)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('an unreachable sandbox is unknown (null), not skew, and is asked again next time', async () => {
    call.mockRejectedValueOnce(new Error('offline'))
    await expect(checkCloudRuntimeSkew('env-1')).resolves.toBeNull()
    call.mockResolvedValueOnce({ id: 'r', ok: false, error: { code: 'x', message: 'y' } })
    await expect(checkCloudRuntimeSkew('env-1')).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(2)
  })
})

describe('useCloudRuntimeSkew', () => {
  it('shows nothing inside the range', async () => {
    call.mockResolvedValue(ok(IN_RANGE))
    const { result } = renderHook(() => useCloudRuntimeSkew('ws', true))
    await waitFor(() => expect(call).toHaveBeenCalled())
    expect(result.current.skew).toBeNull()
  })

  it('does not ask a sandbox that is not running', () => {
    renderHook(() => useCloudRuntimeSkew('ws', false))
    expect(call).not.toHaveBeenCalled()
  })

  it('flags an older sandbox', async () => {
    call.mockResolvedValue(ok(OLDER))
    const { result } = renderHook(() => useCloudRuntimeSkew('ws', true))
    await waitFor(() => expect(result.current.skew?.kind).toBe('sandbox-older'))
  })

  it('flags a newer sandbox until dismissed, and stays dismissed on remount', async () => {
    call.mockResolvedValue(ok(NEWER))
    const first = renderHook(() => useCloudRuntimeSkew('ws', true))
    await waitFor(() => expect(first.result.current.skew?.kind).toBe('desktop-older'))
    act(() => first.result.current.dismiss())
    expect(first.result.current.skew).toBeNull()
    first.unmount()
    const again = renderHook(() => useCloudRuntimeSkew('ws', true))
    expect(again.result.current.skew).toBeNull()
  })

  it('drops the verdict when the workspace moves to another environment', async () => {
    call.mockResolvedValueOnce(ok(NEWER))
    const { result, rerender } = renderHook(() => useCloudRuntimeSkew('ws', true))
    await waitFor(() => expect(result.current.skew?.kind).toBe('desktop-older'))
    call.mockReturnValue(new Promise(() => {}))
    owner.environmentId = 'env-2'
    rerender()
    expect(result.current.skew).toBeNull()
  })

  it('retries while the sandbox has not answered yet', async () => {
    vi.useFakeTimers()
    call.mockRejectedValueOnce(new Error('not yet')).mockResolvedValue(ok(NEWER))
    const { result } = renderHook(() => useCloudRuntimeSkew('ws', true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(call).toHaveBeenCalledTimes(2)
    expect(result.current.skew?.kind).toBe('desktop-older')
  })
})
