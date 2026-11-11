// Every host terminal create goes through the Orca Cloud agent hold first (PC-3b regression: a
// cloud create's first agent was launched by the after-wake seeding through this create and bypassed
// the hold that only wrapped launchAgentInWebHostTab).
import { describe, expect, it, vi } from 'vitest'

const hold = vi.hoisted(() => ({
  createWithCloudAgentHold: vi.fn(async () => ({ outcome: { status: 'created' as const } }))
}))

vi.mock('@/lib/orca-cloud/cloud-web-host-launch-hold', () => hold)
vi.mock(
  '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-routing',
  () => ({
    resolveWebRuntimeSessionEnvironmentId: (id: string | null | undefined) => id ?? 'env-active'
  })
)

const { createWebRuntimeSessionTerminalResult } =
  await import('./web-runtime-terminal-create-operation')

describe('createWebRuntimeSessionTerminalResult', () => {
  it('asks the Orca Cloud agent hold first, with the resolved host, for every create', async () => {
    const args = {
      worktreeId: 'w1',
      environmentId: null,
      command: "claude 'say hello'",
      launchAgent: 'claude' as const,
      preparedAgentCommand: true
    }
    await createWebRuntimeSessionTerminalResult(args)
    expect(hold.createWithCloudAgentHold).toHaveBeenCalledWith(
      { ...args, environmentId: 'env-active' },
      expect.any(Function)
    )
  })
})
