import { describe, expect, it, vi } from 'vitest'

vi.mock('./new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

describe('getAgentLaunchPlatformForRepo', () => {
  it('uses host path planning for runtime-owned repos', async () => {
    const { getAgentLaunchPlatformForRepo } = await import('./agent-launch-platform')

    expect(
      getAgentLaunchPlatformForRepo({
        connectionId: null,
        executionHostId: 'runtime:env-1',
        path: '/workspace/repo'
      })
    ).toBe('linux')
    expect(
      getAgentLaunchPlatformForRepo({
        connectionId: null,
        executionHostId: 'runtime:env-1',
        path: String.raw`C:\Users\alice\repo`
      })
    ).toBe('win32')
  })
})
