import { expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-client'

it('preserves the exact requested timeout when the outbound call begins', async () => {
  const runtimeEnvironmentCall = vi.fn().mockResolvedValue({
    id: 'remote',
    ok: true,
    result: { graphStatus: 'ready' },
    _meta: { runtimeId: 'remote-runtime' }
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentCall }
    }
  })
  const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(1)

  try {
    await callRuntimeRpc(
      { kind: 'environment', environmentId: 'env-timeout' },
      'status.get',
      undefined,
      { timeoutMs: 15_000 }
    )

    expect(runtimeEnvironmentCall.mock.calls[0]?.[0].timeoutMs).toBe(15_000)
  } finally {
    now.mockRestore()
    vi.unstubAllGlobals()
  }
})
