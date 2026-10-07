import { afterEach, expect, it, vi } from 'vitest'

const admit = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/structured-agent-session-host-admission', () => ({
  admitStructuredLaunchOnHost: admit
}))

import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent-test-state'
import { registerWorktreeActivationReset } from './worktree-activation-test-harness'
import { beginHostAdmittedStructuredLaunch } from './structured-agent-session-launch-admission'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'

const initial = useAppStore.getState()
registerWorktreeActivationReset()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initial, true)
})

// Clicking the still-empty workspace while its chat waits on this machine used to seed
// "Terminal 1" beside the chat, through the activation's reseed rather than the watcher.
it('does not seed a shell when the workspace is re-activated while its chat waits on its host', async () => {
  const worktree = makeWorktree()
  seedEmptyActivatableWorktree(worktree)
  vi.stubGlobal('window', { api: { runtime: { call: vi.fn() }, pty: { listSessions: vi.fn() } } })
  const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockResolvedValue('empty')
  let answer!: (admission: { kind: 'admitted' }) => void
  admit.mockReturnValue(new Promise((resolve) => (answer = resolve)))
  const openAdmitted = vi.fn(() => ({ settlement: new Promise<never>(() => {}), cancel: vi.fn() }))
  beginHostAdmittedStructuredLaunch({
    plan: {
      ...adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: 'request-1',
        agent: 'claude',
        worktreeId: worktree.id
      }),
      agent: 'claude'
    },
    hooks: {},
    worktreeId: worktree.id,
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    target: { kind: 'local' },
    openAdmitted,
    onHostDeclined: () => ({ opened: true })
  })

  activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })
  await gate.mock.results[0]?.value
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])

  answer({ kind: 'admitted' })
  await vi.waitFor(() => expect(openAdmitted).toHaveBeenCalledOnce())
  expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toEqual([])
  expect(admit).toHaveBeenCalledOnce()
})
