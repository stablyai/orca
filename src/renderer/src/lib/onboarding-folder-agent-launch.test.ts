import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  launchAgentSession: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/lib/launch-agent-session', () => ({
  launchAgentSession: mocks.launchAgentSession
}))

import { revealOnboardingFolderWithAgentLaunch } from './onboarding-folder-agent-launch'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launcher mock reads only route, agent, and launch from this plan fixture.
const structuredPlan = {
  route: 'structured-native-chat',
  agent: 'codex',
  launch: vi.fn()
} as never

describe('revealOnboardingFolderWithAgentLaunch', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    ['failure', { kind: 'failed', error: new Error('launch failed') }],
    ['cancellation', { kind: 'cancelled' }]
  ])('reveals the folder before a structured launch %s settles', async (_label, outcome) => {
    mocks.launchAgentSession.mockResolvedValue(outcome)

    await revealOnboardingFolderWithAgentLaunch({
      worktreeId: 'folder-1::/workspace',
      executionHostId: 'ssh:connection-1',
      launch: {
        agent: 'codex',
        plan: structuredPlan,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked launcher treats this value as an opaque startup payload.
        fallbackStartup: { command: 'codex', launchAgent: 'codex' } as never
      }
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('folder-1::/workspace', {
      sidebarRevealBehavior: 'auto',
      executionHostId: 'ssh:connection-1',
      providesInitialSurface: true
    })
    expect(mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.launchAgentSession.mock.invocationCallOrder[0]
    )
  })
})
