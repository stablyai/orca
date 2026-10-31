// @vitest-environment happy-dom
import { useAppStore } from '../index'
import { seed, assertU, frame, O, D, C1, C2 } from './workspace-presentation-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { rawWorkspaceState } from '../workspace-composition'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'
import { buildWorkspaceSessionHostSnapshots } from '../../lib/workspace-session-host-persistence'
import { buildHydratedTabState } from './tabs-hydration'
import {
  admitPaneToSession,
  withdrawPaneFromSession
} from '../../../../main/persistence/terminal-topology/terminal-pane-admission'
import { strictWorktreeIdentityKey } from '../../../../shared/workspace-presentation'
import { applyStructuredSessionTabSnapshots } from '../../runtime/local-structured-session-tabs-sync/snapshot-apply'
import {
  localStructuredSessionVersionByWorktree,
  localStructuredSessionEpochHistoryByWorktree
} from '../../runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()
beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  localStructuredSessionVersionByWorktree.clear()
  localStructuredSessionEpochHistoryByWorktree.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('raw sources and independent workspace presentation', () => {
  it('round-trips the edited cross-source split offline through production serializers, host partition and hydration; main admission leaves its source intact', () => {
    const store = seed()
    assertU(store)
    const raw = rawWorkspaceState(store.getState())
    expect(raw.unifiedTabsByWorktree[O][0].worktreeId).toBe(O)
    expect(raw.unifiedTabsByWorktree[D].map((tab) => tab.id)).toEqual([C2])
    const snapshots = buildWorkspaceSessionHostSnapshots(
      buildWorkspaceSessionPayload(store.getState()),
      store.getState()
    )
    const serialized = JSON.parse(JSON.stringify(snapshots[0].state))
    expect(serialized.unifiedTabs[O][0].worktreeId).toBe(O)
    const reopened = createTestStore()
    reopened.setState({
      repos: raw.repos,
      worktreesByRepo: raw.worktreesByRepo,
      activeWorktreeId: D,
      ...buildHydratedTabState(serialized, new Set([O, D])),
      workspacePresentations: JSON.parse(JSON.stringify(raw.workspacePresentations))
    })
    assertU(reopened)
    const added = admitPaneToSession('local', serialized, {
      type: 'createTerminalTab',
      workspace: D,
      groupId: 'right',
      tabId: 'terminal',
      leafId: 'pane'
    })
    expect(added.value).toBe('admitted')
    expect(added.session?.unifiedTabs?.[O]?.[0].worktreeId).toBe(O)
    expect(added.session?.unifiedTabs?.[D]?.some((tab) => tab.id === C1)).toBe(false)
    const removed = withdrawPaneFromSession('local', added.session!, {
      type: 'closePane',
      workspace: D,
      leafId: 'pane'
    })
    expect(removed.session?.unifiedTabs?.[O]?.[0].worktreeId).toBe(O)
  })
  it.each(['F,F,K', 'F,K,F', 'reverse'] as const)(
    'keeps incomparable admitted raw versions independent and subtracts true close immediately (%s)',
    (order) => {
      const store = seed()
      vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
      const apply = (snapshot: RuntimeMobileSessionTabsResult) =>
        applyStructuredSessionTabSnapshots([snapshot])
      if (order === 'reverse') {
        apply(frame(D, 'chat2', 3))
        apply(frame(O, 'chat1', 200))
        assertU(store)
      } else {
        apply(frame(O, 'chat1', 200))
        if (order === 'F,F,K') {
          apply(frame(D, 'chat2', 3))
          assertU(store)
        }
      }
      apply(frame(O, 'chat1', 201, false))
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.entityId)).toEqual([
        'chat2'
      ])
      if (order === 'F,K,F') {
        apply(frame(D, 'chat2', 3))
      }
      apply(frame(O, 'chat1', 199))
      expect(store.getState().unifiedTabsByWorktree[D].map((tab) => tab.entityId)).toEqual([
        'chat2'
      ])
      expect(localStructuredSessionVersionByWorktree.get(O)?.snapshotVersion).toBe(201)
    }
  )
  it('keeps byte-distinct POSIX/WSL owners and instances apart while accepting established Windows aliases', () => {
    expect(strictWorktreeIdentityKey(O)).toBe(strictWorktreeIdentityKey(D))
    for (const [a, b] of [
      ['r::/srv/café', 'r::/srv/café'],
      ['r::/srv/A', 'r::/srv/a'],
      ['r::/srv/a\\b', 'r::/srv/a/b'],
      ['r:://wsl$/Ubuntu/home/A', 'r:://wsl.localhost/ubuntu/home/a']
    ]) {
      expect(strictWorktreeIdentityKey(a)).not.toBe(strictWorktreeIdentityKey(b))
    }
    expect(strictWorktreeIdentityKey('r:://wsl$/UBUNTU/home/café')).toBe(
      strictWorktreeIdentityKey('r:://wsl.localhost/ubuntu/home/café')
    )
  })
})
