import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../src/shared/runtime-types'
import { detectAgentStatusFromTitle } from '../../src/shared/agent-detection'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
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
  const tabId = `tab-${index}`
  const leafId = `leaf-${index}`
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
        parentTabId: `tab-${index}`,
        leafId: `leaf-${index}`,
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
})
