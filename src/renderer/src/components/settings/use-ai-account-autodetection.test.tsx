// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAiAccountAutodetection } from './use-ai-account-autodetection'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: rpc }))

beforeEach(() => rpc.mockReset())

describe('AI account autodetection scope', () => {
  it('defaults missing local settings to on and writes the opt-out', async () => {
    const settings = getDefaultSettings('/synthetic')
    delete settings.automaticallyDetectAiAccounts
    const update = vi.fn()
    const { result } = renderHook(() => useAiAccountAutodetection(settings, update))
    expect(result.current.enabled).toBe(true)
    await act(() => result.current.toggle())
    expect(update).toHaveBeenCalledWith({ automaticallyDetectAiAccounts: false })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('does not offer a working toggle on a host that omits support', async () => {
    rpc.mockResolvedValue({ settings: {} })
    const settings = { ...getDefaultSettings('/synthetic'), activeRuntimeEnvironmentId: 'old' }
    const update = vi.fn()
    const { result } = renderHook(() => useAiAccountAutodetection(settings, update))
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1))
    await act(() => result.current.toggle())
    expect(result.current.enabled).toBeUndefined()
    expect(update).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('reads and updates the selected host without changing local preferences', async () => {
    rpc
      .mockResolvedValueOnce({ settings: { automaticallyDetectAiAccounts: false } })
      .mockResolvedValueOnce({ settings: { automaticallyDetectAiAccounts: true } })
    const settings = { ...getDefaultSettings('/synthetic'), activeRuntimeEnvironmentId: 'remote' }
    const update = vi.fn()
    const { result } = renderHook(() => useAiAccountAutodetection(settings, update))
    await waitFor(() => expect(result.current.enabled).toBe(false))
    await act(() => result.current.toggle())
    expect(rpc).toHaveBeenLastCalledWith(
      { kind: 'environment', environmentId: 'remote' },
      'settings.update',
      { automaticallyDetectAiAccounts: true }
    )
    expect(update).not.toHaveBeenCalled()
    expect(result.current.enabled).toBe(true)
  })
})
