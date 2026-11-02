import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'

const session = vi.hoisted(() => {
  const client = { connectionEpoch: 1, call: vi.fn() }
  const environment = { id: 'env-1', createdAt: 1 }
  return { client, environment, state: { activeClient: client } }
})

vi.mock('./web-runtime-session', () => ({
  getClientForEnvironment: () => session.client,
  requireActiveEnvironment: () => session.environment,
  requireActiveEnvironmentOrNull: () => session.environment,
  runtimeCallQueuePool: { enqueue: (_id: string, _method: string, run: () => unknown) => run() },
  updateEnvironmentFromResponse: () => undefined,
  webRuntimeState: session.state
}))
vi.mock('./web-runtime-worktree-catalog', () => ({
  isMissingPathError: () => false,
  resolveRuntimeFilePath: async () => ({
    worktree: { id: 'wt-1', hostId: 'local' },
    relativePath: 'readme.md'
  })
}))

import { createFileApi } from './web-filesystem-api'

describe('paired web client writes after the client reconnects during the support probe', () => {
  beforeEach(() => {
    session.client.connectionEpoch = 1
    session.client.call.mockReset()
    session.client.call.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        // The same client reconnects while the probe is in flight.
        session.client.connectionEpoch += 1
        return {
          id: 'rpc',
          ok: true,
          result: {
            capabilities: [
              FILE_MUTATION_OWNERSHIP_RUNTIME_CAPABILITY,
              'files.write.disk-precondition.v1'
            ]
          }
        }
      }
      return { id: 'rpc', ok: true, result: { ok: true } }
    })
  })

  it('sends a plain save as before, unpinned', async () => {
    await createFileApi().writeFile({ filePath: '/hub/readme.md', content: 'edited' })

    expect(session.client.call).toHaveBeenLastCalledWith('files.write', expect.anything(), {
      timeoutMs: undefined,
      expectedConnectionEpoch: undefined
    })
  })

  it('refuses to send a guarded save whose probe answered on another connection', async () => {
    await expect(
      createFileApi().writeFile({
        filePath: '/hub/readme.md',
        content: 'edited',
        diskPrecondition: { expectedSignature: getDiskBaselineSignature('original') }
      })
    ).rejects.toThrow()
    expect(session.client.call).toHaveBeenCalledTimes(1)
  })
})
