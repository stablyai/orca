import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import { applyWebSessionTabsSnapshot } from '../../web-session-tabs-sync/snapshot-api'
import { decideWebSessionTabsSnapshot } from '../../web-session-tabs-sync/tracking-decisions'
import {
  recordReceivedWebSessionTabsSnapshot,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from '../../web-session-tabs-sync/tracking'
import {
  makeState as makeMirrorState,
  resetWebSessionTabsSyncTestState
} from '../../web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

// getState: snapshot receipt reads the held paired-tab closes; none here.
vi.mock('../../../store/index', () => ({
  useAppStore: { setState: vi.fn(), getState: () => ({}) }
}))
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
})
