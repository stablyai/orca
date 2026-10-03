import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

function seedWorktree(store: ReturnType<typeof createTestStore>, worktreeId: string): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/path/wt1' })]
    },
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    settings: { ...getDefaultSettings('/tmp'), terminalIncognitoAgents: ['pi'] }
  })
}

describe('createTab incognito stamping', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('marks a launch agent listed in terminalIncognitoAgents as incognito', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedWorktree(store, wt)

    const terminal = store.getState().createTab(wt, undefined, undefined, { launchAgent: 'pi' })

    expect(terminal.incognito).toBe(true)
  })

  it('leaves a non-incognito launch agent unmarked', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedWorktree(store, wt)

    const terminal = store.getState().createTab(wt, undefined, undefined, { launchAgent: 'claude' })

    expect(terminal.incognito).toBeUndefined()
  })

  it('honors an explicit incognito option over the per-agent default', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedWorktree(store, wt)

    const forced = store
      .getState()
      .createTab(wt, undefined, undefined, { launchAgent: 'claude', incognito: true })
    expect(forced.incognito).toBe(true)

    const suppressed = store
      .getState()
      .createTab(wt, undefined, undefined, { launchAgent: 'pi', incognito: false })
    expect(suppressed.incognito).toBeUndefined()
  })
})
