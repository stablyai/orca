import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { applyWebSessionTabsSnapshot, decideWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import {
  makeState as makeMirrorState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const worktree = 'repo::/worktree'

function legacyRecoveryState() {
  return {
    tabsByWorktree: {
      [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
    },
    terminalLayoutsByTabId: {
      'web-terminal-host-tab': {
        root: { type: 'leaf' as const, leafId: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        ptyIdsByLeafId: {
          'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2')
        }
      }
    },
    activeTabIdByWorktree: {},
    activeGroupIdByWorktree: {}
  }
}

const missingSnapshot = {
  worktree,
  publicationEpoch: 'mixed-version',
  snapshotVersion: 1,
  activeGroupId: null,
  activeTabId: null,
  activeTabType: null,
  tabs: []
}

// Shapes a newer host can publish that this client's closed unions do not name.
const newerAgentTab = {
  type: 'agent-session',
  id: 'agent-1',
  title: 'Gemini',
  sessionId: 'session-1',
  agent: 'gemini',
  isActive: false
}
const newerAgentStatus = {
  state: 'future-state',
  prompt: '',
  updatedAt: 1,
  stateStartedAt: 1,
  paneKey: 'host-tab:leaf-1',
  stateHistory: []
}
const newerTabKind = { type: 'notebook', id: 'nb-1', title: 'Notebook', isActive: false }

describe('mixed-version web terminal orphan recovery', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetWebSessionTabsSyncTestState()
  })

  it.each([
    { name: 'recovery response arrives first', streamFirst: false },
    { name: 'subscription update arrives first', streamFirst: true }
  ])('mirrors a new CLI tab after old-host recovery when $name', async ({ streamFirst }) => {
    const environmentId = 'windows-2'
    const runtimeId = 'host-runtime'
    const originalTab = {
      type: 'terminal' as const,
      id: 'host-tab::leaf-1',
      parentTabId: 'host-tab',
      leafId: 'leaf-1',
      title: 'Original',
      isActive: true,
      status: 'ready' as const,
      terminal: 'term_live'
    }
    const adopted: RuntimeMobileSessionTabsResult = {
      ...missingSnapshot,
      publicationEpoch: 'renderer:host',
      snapshotVersion: 2,
      activeTabId: originalTab.id,
      activeTabType: 'terminal',
      tabs: [originalTab]
    }
    const projected = {
      ...adopted,
      publicationEpoch: 'renderer:host:client-navigation',
      snapshotVersion: 3
    }
    const missing = { ...projected, snapshotVersion: 2, tabs: [] }
    let mirror = makeMirrorState({ activeWorktreeId: worktree, ...legacyRecoveryState() })
    const applyReceived = (snapshot: RuntimeMobileSessionTabsResult, frame?: number): void => {
      const received =
        frame ?? recordReceivedWebSessionTabsSnapshot(environmentId, snapshot, undefined, runtimeId)
      if (
        shouldApplyRecoveredWebSessionTabsSnapshot(environmentId, snapshot, received, runtimeId) &&
        decideWebSessionTabsSnapshot(snapshot, environmentId, runtimeId).apply
      ) {
        mirror = { ...mirror, ...applyWebSessionTabsSnapshot(mirror, snapshot, environmentId) }
      }
    }
    const received = recordReceivedWebSessionTabsSnapshot(
      environmentId,
      missing,
      undefined,
      runtimeId
    )
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true,
          result: {
            terminals: [
              {
                handle: 'term_live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true,
                worktreeId: worktree
              }
            ],
            topologyRevisions: { [worktree]: 1 },
            totalCount: 1,
            truncated: false
          }
        }
      }
      if (method === 'terminal.adoptOrphans') {
        if (streamFirst) {
          applyReceived(projected)
        }
        return { ok: true, result: { adopted: true, topologyRevision: 2, snapshot: adopted } }
      }
      if (method === 'session.tabs.list') {
        return { ok: true, result: projected }
      }
      throw new Error(`Unexpected method: ${method}`)
    })
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      legacyRecoveryState(),
      missing,
      environmentId,
      { call: call as never, expectedEnvironmentPairingRevision: 123 }
    )
    expect(recovered).not.toBeNull()
    applyReceived(recovered!, received)
    const newTab = {
      ...originalTab,
      id: 'cli-tab::leaf-2',
      parentTabId: 'cli-tab',
      leafId: 'leaf-2',
      title: 'CLI handoff',
      terminal: 'term_cli',
      isActive: false
    }
    applyReceived({ ...projected, snapshotVersion: 4, tabs: [originalTab, newTab] })

    expect(mirror.tabsByWorktree[worktree]?.map((tab) => tab.id)).toEqual([
      'web-terminal-host-tab',
      'web-terminal-cli-tab'
    ])
    expect(mirror.activeTabIdByWorktree[worktree]).toBe('web-terminal-host-tab')
    if (!streamFirst) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: environmentId,
          method: 'session.tabs.list',
          params: { worktree: `id:${worktree}` },
          expectedEnvironmentPairingRevision: 123
        })
      )
    }
  })

  // Wire-compat Rule 3: recovery must not stall because a newer host publishes a label this client
  // has never seen. Before narrowing the snapshot validator, any of these rejected the whole read
  // and the adopted terminal stayed invisible on every retry.
  it.each([
    { name: 'a new agent-session provider', extend: (tabs: unknown[]) => [...tabs, newerAgentTab] },
    {
      name: 'a new agent status state',
      extend: (tabs: unknown[]) => [{ ...(tabs[0] as object), agentStatus: newerAgentStatus }]
    },
    { name: 'a new tab kind', extend: (tabs: unknown[]) => [...tabs, newerTabKind] }
  ])('completes adoption when a newer host publishes $name', async ({ extend }) => {
    const liveTab = {
      type: 'terminal' as const,
      id: 'host-tab::leaf-1',
      parentTabId: 'host-tab',
      leafId: 'leaf-1',
      title: 'Original',
      isActive: true,
      status: 'ready' as const,
      terminal: 'term_live'
    }
    const projected: RuntimeMobileSessionTabsResult = {
      ...missingSnapshot,
      publicationEpoch: 'renderer:host:client-navigation',
      snapshotVersion: 3,
      activeTabId: liveTab.id,
      activeTabType: 'terminal',
      tabs: extend([liveTab]) as never
    }
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true,
          result: {
            terminals: [
              {
                handle: 'term_live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true,
                worktreeId: worktree
              }
            ],
            topologyRevisions: { [worktree]: 1 },
            totalCount: 1,
            truncated: false
          }
        }
      }
      if (method === 'terminal.adoptOrphans') {
        const snapshot = { ...projected, publicationEpoch: 'renderer:host', snapshotVersion: 2 }
        return { ok: true, result: { adopted: true, topologyRevision: 2, snapshot } }
      }
      return { ok: true, result: projected }
    })

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      legacyRecoveryState(),
      { ...projected, snapshotVersion: 2, tabs: [] },
      'windows-2',
      { call: call as never }
    )

    expect(recovered).toBe(projected)
    expect(call.mock.calls.map(([request]) => request.method)).toEqual([
      'terminal.list',
      'terminal.adoptOrphans',
      'session.tabs.list'
    ])
  })

  it.each([
    {
      name: 'incarnation evidence is unavailable',
      result: {
        terminals: [{ handle: 'term_live', ptyId: 'pty-live', worktreeId: worktree }],
        totalCount: 1,
        truncated: false
      }
    },
    {
      name: 'a legacy unfiltered listing truncates before the candidate',
      result: {
        terminals: [{ handle: 'term_other', ptyId: 'pty-other', worktreeId: worktree }],
        totalCount: 101,
        truncated: true
      }
    }
  ])('keeps the live candidate visible when $name', async ({ result }) => {
    const call = vi.fn(async () => ({ ok: true as const, result }))

    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(
        legacyRecoveryState(),
        missingSnapshot,
        'windows-2',
        { call: call as never }
      )
    ).resolves.toMatchObject({
      tabs: [
        expect.objectContaining({
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          status: 'ready',
          terminal: 'term_live'
        })
      ]
    })
    expect(call).toHaveBeenCalledOnce()
  })
})
