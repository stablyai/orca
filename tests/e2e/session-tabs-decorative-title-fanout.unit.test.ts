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

  it.each([
    ['build ⠁', 'build ⠂'],
    ['Codex working task ⠁', 'Codex working task ⠂']
  ])('publishes meaningful real-title changes from %j to %j', (firstTitle, secondTitle) => {
    const runtime = new OrcaRuntimeService()
    seedWorktree(runtime, 0)
    const published: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => published.push(snapshot))

    runtime.onPtyData('pty-0', `\x1b]0;${firstTitle}\x07`, Date.now())
    vi.advanceTimersByTime(50)
    published.length = 0
    runtime.onPtyData('pty-0', `\x1b]0;${secondTitle}\x07`, Date.now())
    vi.advanceTimersByTime(50)

    expect(published).toHaveLength(1)
    expect(published[0]?.tabs[0]).toMatchObject({ title: secondTitle, ptyId: 'pty-0' })
    unsubscribe()
  })

  it.each([
    {
      agent: 'pi' as const,
      firstTitle: '⠋ π - project',
      heartbeatTitles: ['⠋ π - project', '⠙ π - project'],
      // Why: the π brand swaps for the owner label in place; session text survives.
      expectedTitle: '⠋ Pi - project'
    },
    {
      agent: 'grok-build' as const,
      firstTitle: '⠋ - Waiting for response… - grok',
      heartbeatTitles: ['⠴ - Thinking - grok', '⠦ - Sleep 2s then echo hello… - grok'],
      expectedTitle: '⠋ Grok'
    }
  ])('renews exact and normalized $agent frames beyond the viewer stale boundary', (testCase) => {
    const runtime = new OrcaRuntimeService()
    const firstWorkingTitleAt = Date.now()
    const ptyId = seedWorktree(runtime, 0)
    const internals = runtime as unknown as RuntimeInternals
    internals.ptysById.get(ptyId)!.launchAgent = testCase.agent
    const seededTab = internals.mobileSessionTabsByWorktree.get('workspace-0')?.tabs[0]
    if (seededTab?.type !== 'terminal') {
      throw new Error('expected seeded terminal')
    }
    seededTab.agentStatus = {
      state: 'working',
      prompt: 'task',
      updatedAt: firstWorkingTitleAt,
      stateStartedAt: firstWorkingTitleAt,
      agentType: testCase.agent,
      paneKey: seededTab.id,
      stateHistory: []
    }
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

    runtime.onPtyData(ptyId, `\x1b]0;${testCase.firstTitle}\x07`, Date.now())
    vi.advanceTimersByTime(50)
    expect(publications).toHaveLength(1)
    const initialTerminal = publications[0]?.tabs[0]
    const initialAgentStatus =
      initialTerminal?.type === 'terminal' ? initialTerminal.agentStatus : undefined
    expect(initialAgentStatus?.state).toBe('working')
    publications.length = 0

    for (const title of testCase.heartbeatTitles) {
      vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
      runtime.onPtyData(ptyId, `\x1b]0;${title}\x07`, Date.now())
      vi.advanceTimersByTime(50)
    }

    expect(publications).toHaveLength(2)
    expect(
      publications.map((snapshot) => {
        const terminal = snapshot.tabs[0]
        return terminal?.type === 'terminal' ? terminal.title : null
      })
    ).toEqual([testCase.expectedTitle, testCase.expectedTitle])
    const finalTerminal = publications.at(-1)?.tabs[0]
    const finalAgentStatus =
      finalTerminal?.type === 'terminal' ? finalTerminal.agentStatus : undefined
    expect(finalAgentStatus?.updatedAt).toBeGreaterThan(initialAgentStatus!.updatedAt)
    expect(finalAgentStatus?.stateStartedAt).toBe(initialAgentStatus?.stateStartedAt)
    expect(finalAgentStatus?.prompt).toBe('')
    expect(finalAgentStatus?.agentType).toBe(initialAgentStatus?.agentType)
    const acknowledgedAt = initialAgentStatus!.updatedAt + 1
    expect(acknowledgedAt).toBeGreaterThanOrEqual(finalAgentStatus!.stateStartedAt)
    expect(Date.now() - firstWorkingTitleAt).toBeGreaterThan(AGENT_STATUS_STALE_AFTER_MS)
    const viewerAgentStatus = Object.values(viewerState.agentStatusByPaneKey)[0]
    expect(viewerAgentStatus?.state).toBe('working')
    expect(isAgentStatusFresh(viewerAgentStatus!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(
      true
    )

    publications.length = 0
    vi.advanceTimersByTime(1)
    runtime.onPtyData(ptyId, '\x1b]0;bash\x07', Date.now())
    vi.advanceTimersByTime(50)
    expect(publications).toHaveLength(1)
    const completedTerminal = publications[0]?.tabs[0]
    const completedStatus =
      completedTerminal?.type === 'terminal' ? completedTerminal.agentStatus : undefined
    expect(completedStatus).toMatchObject({ state: 'done', prompt: '' })
    expect(completedStatus?.stateStartedAt).toBeGreaterThan(finalAgentStatus!.stateStartedAt)
    unsubscribe()
  })

  it('does not publish a stored working row over a later permission title', () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = seedWorktree(runtime, 0)
    const internals = runtime as unknown as RuntimeInternals
    const seededTab = internals.mobileSessionTabsByWorktree.get('workspace-0')?.tabs[0]
    if (seededTab?.type !== 'terminal') {
      throw new Error('expected seeded terminal')
    }
    seededTab.agentStatus = {
      state: 'working',
      prompt: 'previous task',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'cursor',
      paneKey: seededTab.id,
      stateHistory: []
    }
    const publications: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      publications.push(structuredClone(snapshot))
    })

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
    vi.advanceTimersByTime(50)
    publications.length = 0
    vi.advanceTimersByTime(1)
    const permissionAt = Date.now()
    runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent waiting\x07', permissionAt)
    vi.advanceTimersByTime(50)

    const terminal = publications.at(-1)?.tabs[0]
    const status = terminal?.type === 'terminal' ? terminal.agentStatus : undefined
    expect(status).toMatchObject({
      state: 'blocked',
      prompt: '',
      updatedAt: permissionAt,
      stateStartedAt: permissionAt
    })
    unsubscribe()
  })

  it('does not publish a prior done row over a newer working title', () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = seedWorktree(runtime, 0)
    const internals = runtime as unknown as RuntimeInternals
    const seededTab = internals.mobileSessionTabsByWorktree.get('workspace-0')?.tabs[0]
    if (seededTab?.type !== 'terminal') {
      throw new Error('expected seeded terminal')
    }
    seededTab.agentStatus = {
      state: 'working',
      prompt: 'first task',
      updatedAt: Date.now(),
      stateStartedAt: Date.now(),
      agentType: 'cursor',
      paneKey: seededTab.id,
      stateHistory: []
    }
    const publications: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      publications.push(structuredClone(snapshot))
    })

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(1)
    runtime.onPtyData(ptyId, '\x1b]0;bash\x07', Date.now())
    vi.advanceTimersByTime(50)
    vi.advanceTimersByTime(1)
    const doneAt = Date.now()
    seededTab.agentStatus = {
      state: 'done',
      prompt: 'first task',
      updatedAt: doneAt,
      stateStartedAt: doneAt,
      agentType: 'cursor',
      paneKey: seededTab.id,
      stateHistory: []
    }
    publications.length = 0

    vi.advanceTimersByTime(1)
    const nextWorkingAt = Date.now()
    runtime.onPtyData(ptyId, '\x1b]0;⠙ Cursor Agent\x07', nextWorkingAt)
    vi.advanceTimersByTime(50)

    const terminal = publications.at(-1)?.tabs[0]
    const status = terminal?.type === 'terminal' ? terminal.agentStatus : undefined
    expect(status).toMatchObject({
      state: 'working',
      prompt: '',
      updatedAt: nextWorkingAt,
      stateStartedAt: nextWorkingAt
    })
    unsubscribe()
  })

  it('holds decorative heartbeats behind unresolved foreground ownership', async () => {
    let resolveForegroundProcess: (agent: string | null) => void = () => undefined
    const foregroundProcess = new Promise<string | null>((resolve) => {
      resolveForegroundProcess = resolve
    })
    const getForegroundProcess = vi.fn(() => foregroundProcess)
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-0' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess
    })
    const ptyId = seedWorktree(runtime, 0)
    const publications: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      publications.push(structuredClone(snapshot))
    })

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Pi\x07', Date.now())
    runtime.onPtyData(ptyId, '\x1b]0;⠙ Pi\x07', Date.now())
    await vi.advanceTimersByTimeAsync(50)
    expect(getForegroundProcess).toHaveBeenCalledTimes(1)
    expect(publications).toHaveLength(0)

    resolveForegroundProcess('pi')
    await vi.advanceTimersByTimeAsync(50)
    expect(publications).toHaveLength(1)
    expect(publications[0]?.tabs[0]).toMatchObject({
      type: 'terminal',
      title: '⠋ Pi',
      agentStatus: { state: 'working' }
    })

    runtime.onPtyData(ptyId, '\x1b]0;⠹ Pi\x07', Date.now())
    await vi.advanceTimersByTimeAsync(50)
    expect(publications).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    runtime.onPtyData(ptyId, '\x1b]0;⠸ Pi\x07', Date.now())
    await vi.advanceTimersByTimeAsync(50)
    expect(publications).toHaveLength(2)
    unsubscribe()
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
