import { expect, it, vi } from 'vitest'
import { structuredAgentSessionCreateParams } from '../../../../../shared/agent-session/lifecycle/operations/structured-agent-session-create'
import type { StructuredLaunchRecoveryState } from './structured-agent-session-launch-recovery'
const host = vi.hoisted(() => ({ creates: vi.fn(), history: vi.fn(), inventory: vi.fn() }))
vi.mock('./structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: host.creates
}))
vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: host.history
}))
vi.mock('@/runtime/native-chat/tab-inventory/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: host.inventory
}))
const { reconcileUnknownLaunch } = await import('./structured-agent-session-launch-recovery')

it('passively reopens an unknown first send by its exact journal identity without another create', async () => {
  const firstMessage = {
    clientMessageId: 'original-first-send',
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'exact original' }]
    }
  }
  const state: StructuredLaunchRecoveryState = {
    intent: {
      sessionId: 'passive-reopen',
      worktreeId: 'wt',
      executionHostId: 'local',
      target: { kind: 'local' },
      agent: 'codex',
      params: structuredAgentSessionCreateParams({
        sessionId: 'passive-reopen',
        worktree: 'id:wt',
        agent: 'codex',
        firstMessage,
        randomUuid: () => '00000000-0000-4000-8000-000000000000',
        now: 1_700_000_000_000
      })
    },
    promise: Promise.resolve({ sessionId: 'passive-reopen', fence: 1 }),
    visibilityUnknown: true,
    cancelled: false
  }
  host.inventory.mockResolvedValue([
    { worktree: 'wt', tabs: [{ type: 'agent-session', sessionId: 'passive-reopen' }] }
  ])
  host.history.mockResolvedValue({
    ok: true,
    page: {
      fence: 9,
      submissions: [{ clientMessageId: 'other-first-send' }],
      window: { nextCursor: null }
    }
  })
  await expect(reconcileUnknownLaunch(state)).rejects.toThrow('did not confirm')
  expect(host.creates).not.toHaveBeenCalled()
  host.history.mockResolvedValue({
    ok: true,
    page: {
      fence: 9,
      submissions: [{ clientMessageId: 'original-first-send' }],
      window: { nextCursor: null }
    }
  })
  expect(await reconcileUnknownLaunch(state)).toMatchObject({
    sessionId: 'passive-reopen',
    firstMessage: { clientMessageId: 'original-first-send' }
  })
  expect(host.creates).not.toHaveBeenCalled()
})
