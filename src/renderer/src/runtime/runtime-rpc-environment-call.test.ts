import { expect, it, vi } from 'vitest'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'

it('preserves abort semantics for runtime-fenced requests', async () => {
  const controller = new AbortController()
  const unsubscribe = vi.fn()
  const call = vi.fn()
  const subscribe = vi.fn().mockResolvedValue({ unsubscribe, sendBinary: vi.fn() })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call, subscribe } } })

  const request = callRuntimeEnvironmentWithRevision({
    environmentId: 'env-1',
    method: 'status.get',
    params: undefined,
    signal: controller.signal,
    expectedRuntimeId: 'runtime-1'
  })
  await vi.waitFor(() => expect(subscribe).toHaveBeenCalled())
  expect(subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ expectedRuntimeId: 'runtime-1' }),
    expect.any(Object)
  )
  controller.abort()

  await expect(request).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  expect(call).not.toHaveBeenCalled()
})
