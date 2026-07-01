import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import type { WorkspaceSessionState } from '../../../../shared/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport', () => ({
  registerEagerPtyBuffer: vi.fn().mockReturnValue({ flush: () => '', dispose: () => {} }),
  ensurePtyDispatcher: vi.fn()
}))

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  repos: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({}),
    remove: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue({}),
    pickFolder: vi.fn().mockResolvedValue(null)
  },
  pty: {
    kill: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn().mockResolvedValue({ id: 'unexpected-spawn' })
  },
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null)
  },
  settings: {
    get: vi.fn().mockResolvedValue({}),
    set: vi.fn().mockResolvedValue(undefined)
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  },
  claudeUsage: usageApi(),
  codexUsage: usageApi(),
  openCodeUsage: usageApi()
}

// @ts-expect-error -- mocked browser preload API
globalThis.window = { api: mockApi }

function usageApi() {
  return {
    getScanState: vi.fn().mockResolvedValue({
      enabled: false,
      isScanning: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      hasAnyClaudeData: false,
      hasAnyCodexData: false,
      hasAnyOpenCodeData: false
    }),
    setEnabled: vi.fn().mockResolvedValue({}),
    refresh: vi.fn().mockResolvedValue({}),
    getSummary: vi.fn().mockResolvedValue(null),
    getDaily: vi.fn().mockResolvedValue([]),
    getBreakdown: vi.fn().mockResolvedValue([]),
    getRecentSessions: vi.fn().mockResolvedValue([])
  }
}

function loadFixture(): unknown {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        'src/shared/workspace-session-upgrade-fixtures/orca-1.4.65-legacy-pty-wake.json'
      ),
      'utf8'
    )
  )
}

function parseFixture(): WorkspaceSessionState {
  const parsed = parseWorkspaceSession(loadFixture())
  expect(parsed.ok).toBe(true)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.value
}

describe('persisted session upgrade fixture', () => {
  it('restores legacy PTY wake hints without blanking or eager spawning', async () => {
    vi.clearAllMocks()
    const session = parseFixture()
    const rawFixture = loadFixture() as Record<string, unknown>
    const worktreeId = session.activeWorktreeId ?? ''
    const store = createTestStore()

    // Why: this fixture represents the pre-sleeping-agent corpus; the older
    // tab/layout PTY evidence is the only recovery source on first launch.
    expect(rawFixture.sleepingAgentSessionsByPaneKey).toBeUndefined()
    seedStore(store, {
      repos: [
        {
          id: 'repo-upgrade',
          path: 'C:\\Users\\user\\orca\\repo',
          displayName: 'Upgrade Repo',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      worktreesByRepo: {
        'repo-upgrade': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-upgrade',
            path: 'C:\\Users\\user\\orca\\upgrade-worktree'
          })
        ]
      }
    })

    store.getState().hydrateWorkspaceSession(session)
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([
      worktreeId,
      FLOATING_TERMINAL_WORKTREE_ID
    ])
    expect(store.getState().tabsByWorktree[worktreeId]).toHaveLength(2)
    expect(store.getState().tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]).toHaveLength(1)

    await store.getState().reconnectPersistedTerminals()

    const state = store.getState()
    expect(state.workspaceSessionReady).toBe(true)
    expect(mockApi.pty.spawn).not.toHaveBeenCalled()
    expect(state.sleepingAgentSessionsByPaneKey).toEqual({})
    expect(state.tabsByWorktree[worktreeId].map((tab) => tab.id)).toEqual([
      'agent-tab',
      'shell-tab'
    ])
    expect(state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID].map((tab) => tab.id)).toEqual([
      'floating-shell-tab'
    ])
    expect(state.tabsByWorktree[worktreeId][0]).toMatchObject({
      id: 'agent-tab',
      ptyId: 'daemon-session-agent-legacy',
      title: 'Agent working',
      launchAgent: 'codex'
    })
    expect(state.tabsByWorktree[worktreeId][1]?.ptyId).toBe('daemon-session-shell-legacy')
    expect(state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID][0]?.ptyId).toBe(
      'daemon-session-floating-legacy'
    )
    expect(state.ptyIdsByTabId).toMatchObject({
      'agent-tab': ['daemon-session-agent-legacy', 'daemon-session-agent-sidecar'],
      'shell-tab': ['daemon-session-shell-legacy'],
      'floating-shell-tab': ['daemon-session-floating-legacy']
    })
    expect(Object.values(state.terminalLayoutsByTabId['agent-tab']?.ptyIdsByLeafId ?? {})).toEqual([
      'daemon-session-agent-legacy',
      'daemon-session-agent-sidecar'
    ])
  })
})
