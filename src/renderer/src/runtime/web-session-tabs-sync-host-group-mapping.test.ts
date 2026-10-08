import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  applyWebSessionTabsSnapshot,
  resolveHostSessionGroupIdForWebSessionTab
} from './web-session-tabs-sync'
import {
  ENV,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

function terminal(parentTabId: string, leafId: string, isActive: boolean) {
  return {
    type: 'terminal' as const,
    id: `${parentTabId}::${leafId}`,
    parentTabId,
    leafId,
    title: 'Terminal',
    status: 'ready' as const,
    terminal: `term_${parentTabId}`,
    isActive
  }
}

describe('host group of a mirrored tab', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('names the host group each mirrored tab sits in, as of the last applied snapshot', () => {
    const resolve = (hostTabId: string) =>
      resolveHostSessionGroupIdForWebSessionTab({
        environmentId: ENV,
        worktreeId: WT,
        tabId: toWebTerminalSurfaceTabId(hostTabId)
      })
    const tabs = [
      terminal('host-tab-1', LEAF_ID, true),
      terminal('host-tab-2', SECOND_LEAF_ID, false)
    ]
    applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(tabs, {
        tabGroups: [
          { id: 'host-left', activeTabId: 'host-tab-1', tabOrder: ['host-tab-1'] },
          { id: 'host-right', activeTabId: 'host-tab-2', tabOrder: ['host-tab-2'] }
        ]
      }),
      ENV,
      NOW
    )
    expect(resolve('host-tab-1')).toBe('host-left')
    expect(resolve('host-tab-2')).toBe('host-right')

    applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(tabs, {
        snapshotVersion: 2,
        tabGroups: [
          { id: 'host-left', activeTabId: 'host-tab-1', tabOrder: ['host-tab-1', 'host-tab-2'] }
        ]
      }),
      ENV,
      NOW
    )
    expect(resolve('host-tab-2')).toBe('host-left')
  })
})
