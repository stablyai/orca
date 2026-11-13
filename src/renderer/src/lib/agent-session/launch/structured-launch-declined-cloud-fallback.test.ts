// CLOUD-HELD-SURFACE: an Orca Cloud create now opens a chat on the strength of the image's
// capabilities. If the VM refuses the chat after all (an older image), the launch falls back to the
// agent's terminal (on a cloud host, the held terminal with its strip), logged, never a dead end.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const admit = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-host-admission', () => ({
  admitStructuredLaunchOnHost: admit
}))

import { beginHostAdmittedStructuredLaunch } from './structured-agent-session-launch-admission'
import { adoptAgentSessionLaunchVerdict } from './routing/agent-session-launch-plan'

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('a cloud VM that declines the chat opens the agent terminal instead, and says so in the log', async () => {
  admit.mockResolvedValue({
    kind: 'declined',
    reason: 'structured sessions unsupported'
  })
  const openAdmitted = vi.fn()
  const onHostDeclined = vi.fn(() => ({ opened: true }))
  const launch = beginHostAdmittedStructuredLaunch({
    plan: {
      ...adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: 'create-1',
        agent: 'claude',
        worktreeId: 'wt-cloud'
      }),
      agent: 'claude'
    },
    hooks: {},
    worktreeId: 'wt-cloud',
    executionHostId: 'runtime:env-cloud',
    target: { kind: 'environment', environmentId: 'env-cloud' },
    openAdmitted,
    onHostDeclined
  })
  await expect(launch.settlement).resolves.toEqual({ kind: 'terminal' })
  expect(onHostDeclined).toHaveBeenCalledWith({
    kind: 'environment',
    environmentId: 'env-cloud'
  })
  expect(openAdmitted).not.toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith(
    '[agent-launch-route] claude chat declined by host runtime:env-cloud (structured sessions unsupported): opening its terminal'
  )
})
