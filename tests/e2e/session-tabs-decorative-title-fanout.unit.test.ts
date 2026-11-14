import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'
import '../../src/shared/agent-status/title/agent-title-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../src/shared/agent-status/contracts/agent-status-freshness'

import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS } from '../../src/main/runtime/session-lifecycle/publication/mobile-session-tabs-agent-status-heartbeat'
import { applyFreshWebSessionTabsSnapshot } from '../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle'
import type { WebSessionTabsSyncState } from '../../src/renderer/src/runtime/web-session-tabs-sync/state'
import { makeAgentStatusStoreWiring } from '../../src/main/runtime/terminal/identity/agent-status-store-wiring.test-fixture'

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const ENVIRONMENT_ID = 'paired-runtime'

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  ptysById: Map<string, { launchAgent: 'grok-build' | 'pi' | null }>
  ptyForegroundAgent: { hasDelayedSnapshot: (ptyId: string) => boolean }
  resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
}

function makeViewerState(): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: 'workspace-0',
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserCertificateFailuresByPageId: {},
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    editorBuffers: {},
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0
  }
}

function seedWorktree(runtime: OrcaRuntimeService, index: number): string {
  const worktreeId = `workspace-${index}`
  const ptyId = `pty-${index}`
  const tabId = `host-tab-${index}`
  const leafId = `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
  runtime.registerPty(ptyId, worktreeId)
  ;(runtime as unknown as RuntimeInternals).mobileSessionTabsByWorktree.set(worktreeId, {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: `group-${index}`,
    activeTabId: `${tabId}::${leafId}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${tabId}::${leafId}`,
        parentTabId: tabId,
        leafId,
        ptyId,
        title: 'Cursor Agent',
        parentLayout: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: ptyId }
        },
        isActive: true
      }
    ]
  })
  return ptyId
}

describe('real PTY decorative session-tabs fanout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renews retained hook status without resetting its state start', () => {
    const statusWiring = makeAgentStatusStoreWiring()
    const runtime = new OrcaRuntimeService(null, undefined, statusWiring.deps)
    const uninstallStatusRepublish = statusWiring.attach(runtime)
    const ptyId = seedWorktree(runtime, 0)
    const internals = runtime as unknown as RuntimeInternals
    const seededTab = internals.mobileSessionTabsByWorktree.get('workspace-0')?.tabs[0]
    if (seededTab?.type !== 'terminal') {
      throw new Error('expected seeded terminal')
    }
    runtime.registerPty(ptyId, 'workspace-0', null, {
      tabId: seededTab.parentTabId,
      leafId: seededTab.leafId
    })
    const publications: RuntimeMobileSessionTabsResult[] = []
    let viewerState = makeViewerState()
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      publications.push(structuredClone(snapshot))
      const patch = applyFreshWebSessionTabsSnapshot(
        viewerState,
        snapshot,
        ENVIRONMENT_ID,
        Date.now()
      )
      viewerState = { ...viewerState, ...patch }
    })

    runtime.onPtyData(
      ptyId,
      '\x1b]9999;{"state":"working","prompt":"retained work","agentType":"codex"}\x07',
      Date.now()
    )
    vi.advanceTimersByTime(50)
    expect(publications).toHaveLength(1)
    const initialTerminal = publications[0]?.tabs[0]
    const initialStatus =
      initialTerminal?.type === 'terminal' ? initialTerminal.agentStatus : undefined
    expect(initialStatus).toMatchObject({ state: 'working', prompt: 'retained work' })
    publications.length = 0

    vi.advanceTimersByTime(10)
    runtime.onPtyData(ptyId, '\x1b]0;⠋ Codex working\x07', Date.now())
    vi.advanceTimersByTime(50)
    expect(publications).toHaveLength(1)
    const titledTerminal = publications[0]?.tabs[0]
    const titledStatus =
      titledTerminal?.type === 'terminal' ? titledTerminal.agentStatus : undefined
    expect(titledStatus).toMatchObject({ state: 'working', prompt: 'retained work' })
    expect(titledStatus?.stateStartedAt).toBe(initialStatus?.stateStartedAt)
    publications.length = 0

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    runtime.onPtyData(ptyId, '\x1b]0;⠙ Codex working\x07', Date.now())
    vi.advanceTimersByTime(50)

    expect(publications).toHaveLength(1)
    const refreshedTerminal = publications[0]?.tabs[0]
    const refreshedStatus =
      refreshedTerminal?.type === 'terminal' ? refreshedTerminal.agentStatus : undefined
    expect(refreshedStatus).toMatchObject({ state: 'working', prompt: 'retained work' })
    expect(refreshedStatus?.updatedAt).toBeGreaterThan(initialStatus!.updatedAt)
    expect(refreshedStatus?.stateStartedAt).toBe(initialStatus?.stateStartedAt)
    expect(initialStatus!.updatedAt + 1).toBeGreaterThanOrEqual(refreshedStatus!.stateStartedAt)

    publications.length = 0
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    runtime.onPtyData(ptyId, '\x1b]0;⠹ Codex working\x07', Date.now())
    vi.advanceTimersByTime(50)

    expect(publications).toHaveLength(1)
    const expiredHookTerminal = publications[0]?.tabs[0]
    const titleOnlyStatus =
      expiredHookTerminal?.type === 'terminal' ? expiredHookTerminal.agentStatus : undefined
    expect(titleOnlyStatus).toMatchObject({ state: 'working', prompt: '' })
    expect(titleOnlyStatus?.updatedAt).toBeGreaterThan(refreshedStatus!.updatedAt)
    expect(titleOnlyStatus?.stateStartedAt).toBe(initialStatus?.stateStartedAt)
    expect(Date.now() - initialStatus!.updatedAt).toBeGreaterThan(AGENT_STATUS_STALE_AFTER_MS)
    const viewerStatus = Object.values(viewerState.agentStatusByPaneKey)[0]
    expect(viewerStatus?.prompt).toBe('')
    expect(isAgentStatusFresh(viewerStatus!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
    unsubscribe()
    uninstallStatusRepublish()
    statusWiring.statusStore.stop()
  })
})
