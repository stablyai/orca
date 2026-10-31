import { vi, type Mock } from 'vitest'

const probe = vi.hoisted(() => vi.fn())
vi.mock('../../src/main/wsl/wsl-runner', () => ({ runWslProcess: probe }))
vi.mock('../../src/main/preflight/agent-detection', async () => {
  const { detectWslCommandsOnPath } =
    await import('../../src/main/ipc/preflight-wsl-agent-detection')
  return {
    detectInstalledAgentsWithShellPathHydration: async () => [
      ...(await detectWslCommandsOnPath({ distro: 'Ubuntu' }, ['claude', 'codex']))
    ],
    refreshShellPathAndDetectAgents: vi.fn()
  }
})

export function directDiscoveryProbe(): Mock {
  return probe
}
