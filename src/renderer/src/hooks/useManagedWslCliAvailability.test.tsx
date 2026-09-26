// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
const call = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: call }))
import { useManagedWslCliAvailability } from './useManagedWslCliAvailability'

afterEach(() => vi.resetAllMocks())
const local: RuntimeClientTarget = { kind: 'local' }
const remote: RuntimeClientTarget = { kind: 'environment', environmentId: 'windows-2' }

it.each([local, remote])(
  'uses the selected host and distro, with fallback until confirmed: %j',
  async (target) => {
    call.mockResolvedValue(true)
    const { result } = renderHook(() => useManagedWslCliAvailability(target, true, ' Ubuntu '))
    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(true))
    expect(call).toHaveBeenCalledWith(
      target,
      'host.wsl.managedCliAvailable',
      { distro: 'Ubuntu' },
      expect.any(Object)
    )
  }
)

it.each([false, undefined])('keeps fallback for an unavailable capability: %s', async (value) => {
  call.mockResolvedValue(value)
  const { result } = renderHook(() => useManagedWslCliAvailability(remote, true))
  await act(async () => {})
  expect(result.current).toBe(false)
})

it('keeps fallback for an old host or unreachable host', async () => {
  call.mockRejectedValue(new Error('method_not_found'))
  const { result } = renderHook(() => useManagedWslCliAvailability(remote, true))
  await act(async () => {})
  expect(result.current).toBe(false)
})

it('does not reuse proof or late responses after changing host or distro', async () => {
  let finish: (value: boolean) => void = () => {}
  call.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve
      })
  )
  call.mockResolvedValue(false)
  const { result, rerender } = renderHook<boolean, { target: RuntimeClientTarget; distro: string }>(
    ({ target, distro }: { target: RuntimeClientTarget; distro: string }) =>
      useManagedWslCliAvailability(target, true, distro),
    {
      initialProps: { target: local, distro: 'Ubuntu' }
    }
  )
  rerender({ target: remote, distro: 'Debian' })
  await act(async () => {
    finish(true)
  })
  expect(result.current).toBe(false)
})

it('immediately drops confirmed availability on a target change or disable', async () => {
  call.mockResolvedValue(true)
  const { result, rerender } = renderHook(
    ({ distro, enabled }) => useManagedWslCliAvailability(local, enabled, distro),
    {
      initialProps: { distro: 'Ubuntu', enabled: true }
    }
  )
  await waitFor(() => expect(result.current).toBe(true))
  call.mockResolvedValue(false)
  rerender({ distro: 'Debian', enabled: true })
  expect(result.current).toBe(false)
  rerender({ distro: 'Ubuntu', enabled: true })
  expect(result.current).toBe(false)
  rerender({ distro: 'Ubuntu', enabled: false })
  expect(result.current).toBe(false)
})

it('does not probe a host runtime or unresolved owner', () => {
  renderHook(() => useManagedWslCliAvailability(null, true))
  renderHook(() => useManagedWslCliAvailability(local, false))
  expect(call).not.toHaveBeenCalled()
})
