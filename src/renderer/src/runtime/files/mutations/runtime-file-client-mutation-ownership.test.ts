import { describe, expect, it } from 'vitest'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../../shared/files-runtime-capabilities'
import { deleteRuntimePath, writeRuntimeFile } from './runtime-file-mutation-client'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../../shared/protocol-version'
import {
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall,
  installRuntimeFileClientEnvironment
} from '../runtime-file-client-test-harness'

installRuntimeFileClientEnvironment()

describe('runtime file client mutation capability', () => {
  it('refuses deletion after a HUB loses mutation support', async () => {
    let statusCalls = 0
    runtimeEnvironmentTransportCall.mockImplementation((args: { method: string }) => {
      if (args.method === 'status.get') {
        statusCalls += 1
        return Promise.resolve({
          id: 'status',
          ok: true,
          result: {
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
            capabilities: statusCalls === 1 ? [FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY] : []
          },
          _meta: { runtimeId: statusCalls === 1 ? 'new-hub-runtime' : 'old-hub-runtime' }
        })
      }
      return runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'write',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'new-hub-runtime' }
    })
    const context = {
      target: { kind: 'environment' as const, environmentId: 'env-downgraded' },
      worktreeId: 'wt-hub-local',
      worktreePath: '/hub/repo',
      expectedExecutionHostId: 'local' as const
    }

    await writeRuntimeFile(context, '/hub/repo/readme.md', 'first')
    await expect(deleteRuntimePath(context, '/hub/repo/readme.md')).rejects.toBeInstanceOf(Error)

    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'files.delete' })
    )
  })
})
