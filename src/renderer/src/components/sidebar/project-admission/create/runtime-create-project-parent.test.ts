import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { getRuntimeDefaultCreateProjectParent } from './runtime-create-project-parent'

const callRuntimeRpc = vi.fn()
const browseRuntimeServerDirectory = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => callRuntimeRpc(...args)
}))
vi.mock('@/runtime/files/reads/runtime-server-directory-browser', () => ({
  browseRuntimeServerDirectory: (...args: unknown[]) => browseRuntimeServerDirectory(...args)
}))

function failure(code: string): RuntimeRpcCallError {
  return new RuntimeRpcCallError({ id: '1', ok: false, error: { code, message: code } })
}

describe('getRuntimeDefaultCreateProjectParent', () => {
  beforeEach(() => {
    callRuntimeRpc.mockReset()
    browseRuntimeServerDirectory.mockReset()
  })

  it("uses the host's own answer", async () => {
    callRuntimeRpc.mockResolvedValueOnce({ parentPath: 'E:\\Code\\orca' })
    await expect(getRuntimeDefaultCreateProjectParent('env-1', 3000)).resolves.toBe(
      'E:\\Code\\orca'
    )
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })

  it('falls back to <host home>/orca/projects on a host without the method', async () => {
    callRuntimeRpc.mockRejectedValueOnce(failure('method_not_found'))
    browseRuntimeServerDirectory.mockResolvedValueOnce({ resolvedPath: 'C:\\Users\\dev' })
    await expect(getRuntimeDefaultCreateProjectParent('env-1', 3000)).resolves.toBe(
      'C:\\Users\\dev\\orca\\projects'
    )
  })

  it('surfaces other failures instead of guessing', async () => {
    callRuntimeRpc.mockRejectedValueOnce(failure('runtime_unavailable'))
    await expect(getRuntimeDefaultCreateProjectParent('env-1', 3000)).rejects.toThrow(
      'runtime_unavailable'
    )
    expect(browseRuntimeServerDirectory).not.toHaveBeenCalled()
  })
})
