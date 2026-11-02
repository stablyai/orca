// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../components/terminal-pane/pty-connection-test-environment'
import { useAppStore } from '../store'
import { createTerminalResidentPolicy } from '../components/terminal-pane/terminal-resident-policy'
import { TerminalSnapshotState } from '../../../shared/terminal-snapshot-state'
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

import {
  WT,
  ENV,
  T0,
  MIRROR_TAB_ID,
  PANE_KEY,
  FACET,
  hostSnapshot
} from './remote-agent-row-program-status.test-fixture'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

type TestStore = ReturnType<typeof createTestStore>

function applyHostSnapshot(store: TestStore, snapshot: RuntimeMobileSessionTabsResult): void {
  const state = store.getState()
  store.setState(applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, Date.now()))
}

/** The renderer's OSC pipeline claims the pane and writes a byte-derived row without a facet. */
function writeClientByteStatus(store: TestStore): void {
  registerRendererOwnedAgentStatusPane(PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      PANE_KEY,
      { state: 'working', prompt: '', agentType: 'claude' },
      'Claude Code',
      undefined,
      { tabId: MIRROR_TAB_ID, worktreeId: WT }
    )
}

function seedClientOwnedPane(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  applyHostSnapshot(store, hostSnapshot(1))
  writeClientByteStatus(store)
  return store
}

describe('mirrored program-status facet on a client-owned pane', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it("takes the host's facet without bumping the agent-status or sort epochs", () => {
    const store = seedClientOwnedPane()
    const before = store.getState()
    expect(before.agentStatusByPaneKey[PANE_KEY]?.programStatus).toBeUndefined()

    applyHostSnapshot(store, hostSnapshot(2, FACET))

    const after = store.getState()
    expect(after.agentStatusByPaneKey[PANE_KEY]?.programStatus).toEqual(FACET)
    expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
    expect(after.sortEpoch).toBe(before.sortEpoch)
  })

  it('drops the facet key once the host clears it', () => {
    const store = seedClientOwnedPane()
    applyHostSnapshot(store, hostSnapshot(2, FACET))

    applyHostSnapshot(store, hostSnapshot(3))

    expect(store.getState().agentStatusByPaneKey[PANE_KEY]).not.toHaveProperty('programStatus')
  })
})

describe('execution-host reported status ownership', () => {
  beforeEach(async () => {
    await installTerminalTestGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })
  afterEach(async () => {
    await restoreTerminalTestGlobals()
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it.each(['raw', 'facts', 'current'] as const)(
    'keeps host Interrupted/background Working and retirement authoritative over %s reports',
    (ingress) => {
      const store = createTestStore()
      seedStore(store, {
        settings: getDefaultSettings('/tmp'),
        worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
        activeWorktreeId: WT
      })
      store.setState({ refreshGitHubForWorktreeIfStale: async () => {} })
      vi.mocked(useAppStore.getState).mockImplementation(() => store.getState())
      applyHostSnapshot(store, hostSnapshot(1, FACET))
      const dispatch = vi.fn()
      const policy = createTerminalResidentPolicy(
        { paneKey: PANE_KEY, tabId: MIRROR_TAB_ID, worktreeId: WT, runtimeEnvironmentId: ENV },
        {
          endpoint: ENV,
          executionHost: `runtime:${ENV}`,
          runtimeId: null,
          ptyId: `remote:${ENV}@@terminal-1`,
          incarnationId: 'physical'
        },
        () => true,
        {
          setCacheTimerStartedAt: vi.fn(),
          markTerminalBell: vi.fn(),
          dispatchNotification: dispatch
        }
      )
      const report = { state: 'done' as const, prompt: '', agentType: 'claude' as const }
      const replayReport = () => {
        if (ingress === 'raw') {
          policy.observeLegacyData(`\x1b]9999;${JSON.stringify(report)}\x07`)
          policy.observeLegacyData('\x1b]7501;state=idle:app=claude\x1b\\')
        } else if (ingress === 'facts') {
          policy.legacySource.observeFacts({
            ptyId: `remote:${ENV}@@terminal-1`,
            seq: 1,
            facts: [{ kind: 'agent-status', payload: report }]
          })
        } else {
          const snapshot = new TerminalSnapshotState()
          snapshot.record({ kind: 'agent-status', payload: report })
          snapshot.record({ kind: 'agent-status', payload: report, fromProgramStatus: true })
          snapshot.record({
            kind: 'program-facet',
            facet: { state: 'idle', observedAt: T0 },
            activity: 'idle'
          })
          policy.restoreCurrent(snapshot.snapshot().current, true)
        }
      }
      try {
        replayReport()
        vi.advanceTimersByTime(3_500)
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
          state: 'working',
          programStatus: FACET
        })
        const interrupted = hostSnapshot(2, FACET)
        Object.assign(interrupted.tabs[0].agentStatus!, {
          state: 'done',
          interrupted: true,
          completionKind: 'cancellation'
        })
        applyHostSnapshot(store, interrupted)
        replayReport()
        vi.advanceTimersByTime(3_500)
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
          state: 'done',
          interrupted: true
        })
        applyHostSnapshot(store, hostSnapshot(3, FACET))
        replayReport()
        vi.advanceTimersByTime(3_500)
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toMatchObject({
          state: 'working',
          programStatus: FACET
        })
        const retired = hostSnapshot(4)
        delete retired.tabs[0].agentStatus
        applyHostSnapshot(store, retired)
        replayReport()
        vi.advanceTimersByTime(3_500)
        expect(store.getState().agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
        if (ingress === 'current') {
          expect(dispatch).not.toHaveBeenCalled()
        } else {
          expect(dispatch).toHaveBeenCalled()
        }
      } finally {
        policy.dispose()
      }
    }
  )
})
