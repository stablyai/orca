import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'
import { detectAgentStatusFromTitle } from '../../src/shared/agent-detection'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../src/shared/agent-status-types'
import { isExplicitAgentStatusFresh } from '../../src/renderer/src/lib/agent-status'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS,
  SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
} from '../../src/main/runtime/mobile-session-tabs-agent-status-heartbeat'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from '../../src/renderer/src/runtime/web-session-tabs-sync'

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const ENVIRONMENT_ID = 'paired-runtime'
const WORKTREE_COUNT = 24
const DECORATIVE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type RuntimeInternals = {
  mobileSessionTabsByWorktree: Map<string, RuntimeMobileSessionTabsSnapshot>
  ptysById: Map<string, { launchAgent: 'grok-build' | 'pi' | null }>
  ptyDelayedForegroundSnapshotTitleObservations: Map<string, number>
  resetTrackedTerminalStateForProviderGeneration: (ptyId: string) => void
}

type FanoutCounters = {
  hostPublications: number
  serializedBytes: number
  rendererApplyCalls: number
  rendererStoreMutations: number
  rawTerminalChunks: number
}

type FanoutEvidence = {
  publishedByWorktree: Map<string, RuntimeMobileSessionTabsResult[]>
  rawChunksByPty: Map<string, string[]>
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

function resetCounters(counters: FanoutCounters): void {
  counters.hostPublications = 0
  counters.serializedBytes = 0
  counters.rendererApplyCalls = 0
  counters.rendererStoreMutations = 0
  counters.rawTerminalChunks = 0
}

function resetEvidence(evidence: FanoutEvidence): void {
  evidence.publishedByWorktree.clear()
  evidence.rawChunksByPty.clear()
}

function recordByKey<T>(map: Map<string, T[]>, key: string, value: T): void {
  const entries = map.get(key) ?? []
  entries.push(value)
  map.set(key, entries)
}

describe('real PTY decorative session-tabs fanout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('bounds host publication and renderer application across remote worktrees', () => {
    const runtime = new OrcaRuntimeService()
    const ptyIds = Array.from({ length: WORKTREE_COUNT }, (_, index) =>
      seedWorktree(runtime, index)
    )
    const counters: FanoutCounters = {
      hostPublications: 0,
      serializedBytes: 0,
      rendererApplyCalls: 0,
      rendererStoreMutations: 0,
      rawTerminalChunks: 0
    }
    const evidence: FanoutEvidence = {
      publishedByWorktree: new Map(),
      rawChunksByPty: new Map()
    }
    let viewerState = makeViewerState()
    const dataUnsubscribes = ptyIds.map((ptyId) =>
      runtime.subscribeToTerminalData(ptyId, (data) => {
        counters.rawTerminalChunks += 1
        recordByKey(evidence.rawChunksByPty, ptyId, data)
      })
    )
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      counters.hostPublications += 1
      counters.serializedBytes += Buffer.byteLength(JSON.stringify(snapshot))
      recordByKey(evidence.publishedByWorktree, snapshot.worktree, structuredClone(snapshot))
      counters.rendererApplyCalls += 1
      const patch = applyFreshWebSessionTabsSnapshot(
        viewerState,
        snapshot,
        ENVIRONMENT_ID,
        Date.now()
      )
      if (patch !== viewerState) {
        counters.rendererStoreMutations += 1
        viewerState = { ...viewerState, ...patch }
      }
    })

    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
    }
    vi.advanceTimersByTime(50)
    expect(counters.hostPublications).toBe(WORKTREE_COUNT)
    expect(counters.rendererStoreMutations).toBe(WORKTREE_COUNT)
    resetCounters(counters)
    resetEvidence(evidence)

    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const frame of DECORATIVE_FRAMES) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, `\x1b]0;${frame} Cursor Agent\x07`, Date.now())
        }
        vi.advanceTimersByTime(30)
      }
    }
    vi.advanceTimersByTime(50)

    expect(counters).toEqual({
      hostPublications: 0,
      serializedBytes: 0,
      rendererApplyCalls: 0,
      rendererStoreMutations: 0,
      rawTerminalChunks: WORKTREE_COUNT * DECORATIVE_FRAMES.length * 4
    })
    for (const ptyId of ptyIds) {
      expect(evidence.rawChunksByPty.get(ptyId)).toEqual(
        Array.from({ length: 4 }, () =>
          DECORATIVE_FRAMES.map((frame) => `\x1b]0;${frame} Cursor Agent\x07`)
        ).flat()
      )
    }
    expect(evidence.publishedByWorktree.size).toBe(0)

    resetCounters(counters)
    resetEvidence(evidence)
    for (let cycle = 0; cycle < 4; cycle += 1) {
      for (const frame of DECORATIVE_FRAMES) {
        for (const ptyId of ptyIds) {
          runtime.onPtyData(ptyId, '\x1b]0;Cursor Agent\x07', Date.now())
          runtime.onPtyData(ptyId, `\x1b]0;${frame} Cursor Agent\x07`, Date.now())
        }
        vi.advanceTimersByTime(30)
      }
    }
    vi.advanceTimersByTime(50)
    expect(counters).toEqual({
      hostPublications: 0,
      serializedBytes: 0,
      rendererApplyCalls: 0,
      rendererStoreMutations: 0,
      rawTerminalChunks: WORKTREE_COUNT * DECORATIVE_FRAMES.length * 8
    })
    for (const ptyId of ptyIds) {
      expect(evidence.rawChunksByPty.get(ptyId)).toEqual(
        Array.from({ length: 4 }, () =>
          DECORATIVE_FRAMES.flatMap((frame) => [
            '\x1b]0;Cursor Agent\x07',
            `\x1b]0;${frame} Cursor Agent\x07`
          ])
        ).flat()
      )
    }
    expect(evidence.publishedByWorktree.size).toBe(0)

    resetCounters(counters)
    resetEvidence(evidence)
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;Cursor ready\x07', Date.now())
    }
    vi.advanceTimersByTime(50)
    expect(counters.hostPublications).toBe(WORKTREE_COUNT)
    expect(counters.rendererApplyCalls).toBe(WORKTREE_COUNT)
    expect(counters.rendererStoreMutations).toBe(WORKTREE_COUNT)
    expect(counters.serializedBytes).toBeGreaterThan(0)
    for (let index = 0; index < WORKTREE_COUNT; index += 1) {
      const worktreeId = `workspace-${index}`
      const snapshots = evidence.publishedByWorktree.get(worktreeId)
      expect(snapshots).toHaveLength(1)
      const terminal = snapshots?.[0]?.tabs[0]
      expect(terminal).toMatchObject({
        type: 'terminal',
        parentTabId: `host-tab-${index}`,
        leafId: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
        ptyId: `pty-${index}`,
        title: 'Cursor ready'
      })
      expect(terminal?.type === 'terminal' ? terminal.agentStatus?.state : undefined).toBe('done')
      expect(viewerState.tabsByWorktree[worktreeId]).toEqual([
        expect.objectContaining({ title: 'Cursor ready', worktreeId })
      ])
      expect(
        detectAgentStatusFromTitle(viewerState.tabsByWorktree[worktreeId]?.[0]?.title ?? '')
      ).toBe('idle')
      expect(evidence.rawChunksByPty.get(`pty-${index}`)).toEqual(['\x1b]0;Cursor ready\x07'])
    }

    resetCounters(counters)
    resetEvidence(evidence)
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, 'visible output\r\n', Date.now())
    }
    vi.advanceTimersByTime(50)
    expect(counters).toEqual({
      hostPublications: 0,
      serializedBytes: 0,
      rendererApplyCalls: 0,
      rendererStoreMutations: 0,
      rawTerminalChunks: WORKTREE_COUNT
    })
    for (const ptyId of ptyIds) {
      expect(evidence.rawChunksByPty.get(ptyId)).toEqual(['visible output\r\n'])
    }
    expect(evidence.publishedByWorktree.size).toBe(0)

    unsubscribe()
    for (const dispose of dataUnsubscribes) {
      dispose()
    }
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

  it('globally caps decorative freshness while every working status stays fresh', () => {
    const runtime = new OrcaRuntimeService()
    const firstWorkingTitleAt = Date.now()
    const ptyIds = Array.from({ length: WORKTREE_COUNT }, (_, index) =>
      seedWorktree(runtime, index)
    )
    const publications: {
      worktreeId: string
      at: number
      updatedAt: number
      stateStartedAt: number
    }[] = []
    let viewerState = makeViewerState()
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => {
      const terminal = snapshot.tabs[0]
      if (terminal?.type !== 'terminal') {
        return
      }
      publications.push({
        worktreeId: snapshot.worktree,
        at: Date.now(),
        updatedAt: terminal.agentStatus?.updatedAt ?? 0,
        stateStartedAt: terminal.agentStatus?.stateStartedAt ?? 0
      })
      const patch = applyFreshWebSessionTabsSnapshot(
        viewerState,
        snapshot,
        ENVIRONMENT_ID,
        Date.now()
      )
      viewerState = { ...viewerState, ...patch }
    })

    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;⠋ Cursor Agent\x07', Date.now())
    }
    vi.advanceTimersByTime(50)
    const initialStateStartedAtByWorktree = new Map(
      publications.map(({ worktreeId, stateStartedAt }) => [worktreeId, stateStartedAt])
    )
    publications.length = 0

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS - 51)
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;⠙ Cursor Agent\x07', Date.now())
    }
    vi.advanceTimersByTime(50)
    expect(publications).toEqual([])

    vi.advanceTimersByTime(1)
    const heartbeatStartedAt = Date.now()
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;⠹ Cursor Agent\x07', Date.now())
    }
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS * WORKTREE_COUNT + 50)

    expect(publications.map(({ worktreeId }) => worktreeId).sort()).toEqual(
      Array.from({ length: WORKTREE_COUNT }, (_, index) => `workspace-${index}`).sort()
    )
    for (let index = 1; index < publications.length; index += 1) {
      expect(publications[index]!.at - publications[index - 1]!.at).toBeGreaterThanOrEqual(
        SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS
      )
    }
    for (const publication of publications) {
      expect(publication.updatedAt).toBeGreaterThanOrEqual(heartbeatStartedAt)
      expect(Date.now() - publication.updatedAt).toBeLessThan(AGENT_STATUS_STALE_AFTER_MS)
      expect(publication.stateStartedAt).toBe(
        initialStateStartedAtByWorktree.get(publication.worktreeId)
      )
    }
    publications.length = 0

    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_INTERVAL_MS)
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;⠸ Cursor Agent\x07', Date.now())
    }
    vi.advanceTimersByTime(SESSION_TABS_AGENT_STATUS_HEARTBEAT_SPACING_MS * WORKTREE_COUNT + 50)
    expect(publications).toHaveLength(WORKTREE_COUNT)
    expect(Date.now() - firstWorkingTitleAt).toBeGreaterThan(AGENT_STATUS_STALE_AFTER_MS)
    const viewerAgentStatuses = Object.values(viewerState.agentStatusByPaneKey)
    expect(viewerAgentStatuses).toHaveLength(WORKTREE_COUNT)
    expect(
      viewerAgentStatuses.every(
        (entry) =>
          entry.state === 'working' &&
          isExplicitAgentStatusFresh(entry, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
      )
    ).toBe(true)

    publications.length = 0
    const completionAt = Date.now()
    for (const ptyId of ptyIds) {
      runtime.onPtyData(ptyId, '\x1b]0;Cursor ready\x07', Date.now())
    }
    vi.advanceTimersByTime(50)
    expect(publications).toHaveLength(WORKTREE_COUNT)
    expect(publications.every(({ updatedAt }) => updatedAt === completionAt)).toBe(true)
    unsubscribe()
  })

  it.each([
    {
      agent: 'pi' as const,
      firstTitle: '⠋ π - project',
      heartbeatTitles: ['⠋ π - project', '⠙ π - project'],
      expectedTitle: '⠋ Pi'
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
      publications.every((snapshot) => {
        const terminal = snapshot.tabs[0]
        return terminal?.type === 'terminal' && terminal.title === testCase.expectedTitle
      })
    ).toBe(true)
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
    expect(
      isExplicitAgentStatusFresh(viewerAgentStatus!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
    ).toBe(true)

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

  it('clears delayed ownership markers when tracked terminal state resets', async () => {
    let resolveForegroundProcess: (agent: string | null) => void = () => undefined
    const foregroundProcess = new Promise<string | null>((resolve) => {
      resolveForegroundProcess = resolve
    })
    const runtime = new OrcaRuntimeService()
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-0' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: () => foregroundProcess
    })
    const ptyId = seedWorktree(runtime, 0)
    const internals = runtime as unknown as RuntimeInternals

    runtime.onPtyData(ptyId, '\x1b]0;⠋ Pi\x07', Date.now())
    await vi.advanceTimersByTimeAsync(0)
    expect(internals.ptyDelayedForegroundSnapshotTitleObservations.has(ptyId)).toBe(true)

    internals.resetTrackedTerminalStateForProviderGeneration(ptyId)
    expect(internals.ptyDelayedForegroundSnapshotTitleObservations.has(ptyId)).toBe(false)
    resolveForegroundProcess(null)
    await vi.advanceTimersByTimeAsync(0)
  })

  it('renews retained hook status without resetting its state start', () => {
    const runtime = new OrcaRuntimeService()
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
    expect(isExplicitAgentStatusFresh(viewerStatus!, Date.now(), AGENT_STATUS_STALE_AFTER_MS)).toBe(
      true
    )
    unsubscribe()
  })
})
