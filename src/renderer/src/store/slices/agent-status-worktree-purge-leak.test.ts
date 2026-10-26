/** Bulk worktree purge must clear pane status/unread/input maps like single removal. External scans/project removal/hydration run no terminal teardown; missed entries otherwise leak for renderer lifetime and leave unread dock badges. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AppState } from '../types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree, makeTab } from './store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  countAgentPaneAuthorityAliasesForTests,
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey,
  transferAgentPaneAuthorityAlias
} from './agent-pane-authority'

const WT = 'repo1::/path/wt1'
const TAB = 'tab-1'
const PANE = `${TAB}:leaf-a`

function liveEntry(paneKey: string): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'p',
    updatedAt: 0,
    stateStartedAt: 0,
    paneKey,
    stateHistory: []
  }
}

function launchEntry(): AppState['agentLaunchConfigByPaneKey'][string] {
  return { launchConfig: { agentArgs: '', agentEnv: {} }, registeredAt: 0, identity: {} }
}

function sleepingRecord(paneKey: string, worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: '',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

function seedPaneState(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    tabsByWorktree: { [WT]: [makeTab({ id: TAB, worktreeId: WT })] },
    agentStatusByPaneKey: { [PANE]: liveEntry(PANE) },
    agentLaunchConfigByPaneKey: {
      [PANE]: { launchConfig: {}, registeredAt: 0, identity: {} }
    } as unknown as AppState['agentLaunchConfigByPaneKey'],
    acknowledgedAgentsByPaneKey: { [PANE]: 1 },
    paneForegroundAgentByPaneKey: { [PANE]: { agent: null, shellForeground: true } },
    sleepingAgentSessionsByPaneKey: {
      [PANE]: {}
    } as unknown as AppState['sleepingAgentSessionsByPaneKey'],
    unreadTerminalTabs: { [TAB]: true },
    unreadTerminalPanes: { [PANE]: true },
    unreadAgentCompletionPanes: { [PANE]: true },
    lastTerminalInputAtByPaneKey: { [PANE]: 123 }
  })
}

describe('bulk worktree purge evicts pane-scoped agent/unread/input maps (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('purgeWorktreeTerminalState drops every pane-scoped map for the removed worktree', () => {
    const store = createTestStore()
    seedPaneState(store)
    const epochBefore = store.getState().agentStatusEpoch

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.agentStatusEpoch).toBe(epochBefore + 1)
    expect(s.agentLaunchConfigByPaneKey[PANE]).toBeUndefined()
    expect(s.acknowledgedAgentsByPaneKey[PANE]).toBeUndefined()
    expect(s.paneForegroundAgentByPaneKey[PANE]).toBeUndefined()
    expect(s.sleepingAgentSessionsByPaneKey[PANE]).toBeUndefined()
    expect(s.unreadTerminalTabs[TAB]).toBeUndefined()
    expect(s.unreadTerminalPanes[PANE]).toBeUndefined()
    expect(s.unreadAgentCompletionPanes[PANE]).toBeUndefined()
    expect(s.lastTerminalInputAtByPaneKey[PANE]).toBeUndefined()
  })

  it('keeps pane-scoped state for worktrees that are NOT removed', () => {
    const store = createTestStore()
    const OTHER = 'repo1::/path/wt2'
    const OTHER_TAB = 'tab-2'
    const OTHER_PANE = `${OTHER_TAB}:leaf-b`
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: OTHER, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: {
        [WT]: [makeTab({ id: TAB, worktreeId: WT })],
        [OTHER]: [makeTab({ id: OTHER_TAB, worktreeId: OTHER })]
      },
      agentStatusByPaneKey: { [PANE]: liveEntry(PANE), [OTHER_PANE]: liveEntry(OTHER_PANE) },
      unreadTerminalTabs: { [TAB]: true, [OTHER_TAB]: true },
      lastTerminalInputAtByPaneKey: { [PANE]: 1, [OTHER_PANE]: 2 }
    })

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.agentStatusByPaneKey[PANE]).toBeUndefined()
    expect(s.agentStatusByPaneKey[OTHER_PANE]).toBeDefined()
    expect(s.unreadTerminalTabs[OTHER_TAB]).toBe(true)
    expect(s.lastTerminalInputAtByPaneKey[OTHER_PANE]).toBe(2)
  })

  it('drops sleeping records of the removed worktree whose tab is already gone (#24784)', () => {
    const store = createTestStore()
    const OTHER = 'repo1::/path/wt2'
    // Why no tab: a record can outlive its tab, so the tab-prefix purge alone cannot reach it.
    const ORPHAN_PANE = 'gone-tab:leaf-z'
    const OTHER_PANE = 'other-tab:leaf-y'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: OTHER, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      tabsByWorktree: { [WT]: [], [OTHER]: [] },
      agentLaunchConfigByPaneKey: {
        [ORPHAN_PANE]: launchEntry(),
        [OTHER_PANE]: launchEntry()
      },
      sleepingAgentSessionsByPaneKey: {
        [ORPHAN_PANE]: sleepingRecord(ORPHAN_PANE, WT),
        [OTHER_PANE]: sleepingRecord(OTHER_PANE, OTHER)
      }
    })

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(Object.keys(s.sleepingAgentSessionsByPaneKey)).toEqual([OTHER_PANE])
    expect(Object.keys(s.agentLaunchConfigByPaneKey)).toEqual([OTHER_PANE])
  })

  it('purgeWorktreeTerminalState forgets pane-authority aliases for the removed tabs', () => {
    resetAgentPaneAuthorityAliasesForTests()
    const store = createTestStore()
    const leafId = '77777777-7777-4777-8777-777777777777'
    const sourcePaneKey = makePaneKey('tab-detached', leafId)
    const ownerPaneKey = makePaneKey(TAB, leafId)
    seedPaneState(store)
    transferAgentPaneAuthorityAlias({
      fromPaneKey: sourcePaneKey,
      toPaneKey: ownerPaneKey,
      ptyId: 'pty-1'
    })
    expect(resolveAgentPaneAuthorityKey(sourcePaneKey)).toBe(ownerPaneKey)

    store.getState().purgeWorktreeTerminalState([WT])

    // Purge authority aliases too or module registry keeps routing posts to removed panes.
    expect(resolveAgentPaneAuthorityKey(sourcePaneKey)).toBe(sourcePaneKey)
    expect(countAgentPaneAuthorityAliasesForTests()).toBe(0)
    resetAgentPaneAuthorityAliasesForTests()
  })
})
