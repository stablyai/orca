// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LaunchModule from '@/lib/launch-structured-agent-session'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(),
  history: vi.fn(),
  inventory: vi.fn()
}))

vi.mock('@/lib/launch-structured-agent-session', async (importOriginal) => {
  const actual = await importOriginal<typeof LaunchModule>()
  return { ...actual, launchStructuredAgentSession: mocks.launch }
})

vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: mocks.inventory
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.history,
  supportsStructuredAgentSessionCreateMessage: async () => false
}))

import { createStructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import { launchAndReconcile } from '@/lib/structured-agent-session-launch-recovery'

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function launchState(worktreeId: string) {
  return {
    intent: createStructuredAgentSessionLaunchIntent(worktreeId, 'codex', 'local'),
    promise: Promise.resolve({ sessionId: '', fence: 0 }),
    visibilityUnknown: false,
    cancelled: false
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.history.mockResolvedValue({ ok: true, page: { fence: 1 } })
})

// The create already made the chat. A tab the inventory has not listed yet is a confirmation
// gap: asking for a second create leaves a duplicate chat and strands the first one.
describe('a created chat its inventory does not list yet', () => {
  it('re-reads the created chat instead of creating a second one', async () => {
    const state = launchState('wt-lag')
    mocks.launch.mockResolvedValue({ sessionId: state.intent.sessionId, fence: 1 })
    mocks.inventory.mockResolvedValue([])

    const error = await launchAndReconcile(state).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('structured session tab publication unavailable')
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(state.visibilityUnknown).toBe(true)
  })

  it('settles the launch when the re-read lists the tab', async () => {
    const state = launchState('wt-lag-recovered')
    mocks.launch.mockResolvedValue({ sessionId: state.intent.sessionId, fence: 1 })
    mocks.inventory
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot('wt-lag-recovered', state.intent.sessionId)])

    await expect(launchAndReconcile(state)).resolves.toMatchObject({
      sessionId: state.intent.sessionId,
      fence: 1
    })
    expect(mocks.launch).toHaveBeenCalledOnce()
    expect(mocks.inventory).toHaveBeenCalledTimes(2)
    expect(state.visibilityUnknown).toBe(false)
  })
})
