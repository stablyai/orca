import { describe, expect, it } from 'vitest'
import { getRuntimeServerProblemLine } from './runtime-server-row-meta'

describe('getRuntimeServerProblemLine', () => {
  it('shows a replaced server’s recovery even when its status probe failed (#37766)', () => {
    const problem = 'Forget this server, then connect the SSH host.'
    expect(
      getRuntimeServerProblemLine({
        environment: { lastUsedAt: 1 },
        row: {
          accessRevoked: false,
          serverReplaced: true,
          problem,
          probeFailed: true,
          compatibilityBlocked: false
        },
        remoteUpdate: undefined,
        managedStatusError: 'status probe failed',
        managedSummary: null,
        address: '127.0.0.1:6768'
      })
    ).toEqual({ text: problem, destructive: true })
  })
})
