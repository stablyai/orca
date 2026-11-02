// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { ProgramStatusFacet } from '../../../shared/program-status/facet'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
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
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot
} from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { applyWebSessionTabsStorePatch } from './web-session-tabs-sync/store-patch'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'
import { resetAgentHookCompletionNotificationCoordinators } from '@/hooks/agent-hook-completion-notifications'
import { resetAgentCompletionCoordinatorIdentitiesForTest } from '../components/terminal-pane/agent-completion-coordinator'
import { captureTerminalFactSubject } from '../components/terminal-pane/terminal-fact-subject'
import { createNotificationDeliveryService } from '../../../main/notifications/notification-delivery-service'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))
vi.mock('../../../main/i18n/main-i18n', () => ({ translateMain: (key: string) => key }))

const WT = 'repo1::/path/wt1'
const ENV = 'remote-env-1'
const T0 = 1_700_000_000_000
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)
const PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF_ID)
const FACET: ProgramStatusFacet = { state: 'working', progress: 40, observedAt: T0 }

type TestStore = ReturnType<typeof createTestStore>

function hostSnapshot(
  snapshotVersion: number,
  programStatus?: ProgramStatusFacet
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: `${HOST_TAB_ID}::${LEAF_ID}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${HOST_TAB_ID}::${LEAF_ID}`,
        title: 'Claude Code',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        launchAgent: 'claude',
        status: 'ready',
        terminal: 'terminal-1',
        agentStatus: {
          state: 'working',
          prompt: '',
          updatedAt: T0 - 1_000,
          stateStartedAt: T0 - 2_000,
          agentType: 'claude',
          paneKey: makePaneKey(HOST_TAB_ID, LEAF_ID),
          tabId: HOST_TAB_ID,
          worktreeId: WT,
          stateHistory: [],
          ...(programStatus ? { programStatus } : {})
        }
      }
    ]
  }
}

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
        { ptyId: `remote:${ENV}@@terminal-1`, incarnationId: 'physical' },
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

// Both live inputs share final admission and delivery; neither may publish a client status row.
describe('remote live report and accepted host notification arbitration', () => {
  beforeEach(async () => {
    await installTerminalTestGlobals()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
    resetAgentHookCompletionNotificationCoordinators()
    resetAgentCompletionCoordinatorIdentitiesForTest()
  })
  afterEach(async () => {
    resetAgentHookCompletionNotificationCoordinators()
    resetAgentCompletionCoordinatorIdentitiesForTest()
    await restoreTerminalTestGlobals()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  function setup(desktop: boolean) {
    const store = createTestStore()
    const settings = getDefaultSettings('/tmp')
    settings.notifications.agentTaskComplete = desktop
    settings.notifications.terminalBell = true
    settings.notifications.suppressWhenFocused = false
    settings.experimentalTerminalAttention = desktop
    seedStore(store, {
      settings,
      worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
      activeWorktreeId: WT
    })
    store.setState({ refreshGitHubForWorktreeIfStale: async () => {} })
    vi.mocked(useAppStore.getState).mockImplementation(() => store.getState())
    vi.mocked(useAppStore.subscribe).mockImplementation(store.subscribe)
    const mobile = vi.fn()
    const native = vi.fn(() => ({ delivered: true as const }))
    const delivery = createNotificationDeliveryService({
      readNotificationSettings: () => settings.notifications,
      findActiveWindow: () => null,
      isWindowVisible: () => false,
      setTrayAttention: vi.fn(),
      isNotificationSupported: () => true,
      dispatchMobileNotification: mobile,
      readAuthorizationStatus: async () => 'authorized',
      recordDeliveryOutcome: vi.fn(),
      deliverNative: native,
      platform: 'linux',
      now: Date.now
    })
    const requests = vi
      .spyOn(window.api.notifications, 'dispatch')
      .mockImplementation(async (request) => delivery.dispatch(request))
    const apply = (snapshot: RuntimeMobileSessionTabsResult, live = true) => {
      const decision = decideWebSessionTabsSnapshot(snapshot, ENV)
      applyWebSessionTabsStorePatch(
        (state, keys) =>
          applyWebSessionTabsSnapshot(state, snapshot, ENV, Date.now(), undefined, keys),
        { frames: [{ environmentId: ENV, worktreeId: WT, decision }] },
        snapshot,
        live
      )
    }
    // The admitted physical source supplies the live PTY binding independently of tab hydration.
    apply(hostSnapshot(1), false)
    store.setState({
      ptyIdsByTabId: { [MIRROR_TAB_ID]: [`remote:${ENV}@@terminal-1`] },
      terminalLayoutsByTabId: {
        [MIRROR_TAB_ID]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: `remote:${ENV}@@terminal-1` }
        }
      }
    })
    vi.stubGlobal('window', {
      ...window,
      api: { ...window.api, worktrees: { ...window.api.worktrees, updateMeta: vi.fn() } }
    })
    const policy = createTerminalResidentPolicy(
      { paneKey: PANE_KEY, tabId: MIRROR_TAB_ID, worktreeId: WT, runtimeEnvironmentId: ENV },
      { ptyId: `remote:${ENV}@@terminal-1`, incarnationId: 'physical' },
      () => true
    )
    const report = (state: 'working' | 'done', turnCompletedAt?: number) =>
      policy.observeLegacyData(
        `\x1b]9999;${JSON.stringify({
          state,
          prompt: 'finish the turn',
          agentType: 'claude',
          ...(state === 'done' ? { lastAssistantMessage: 'Done.' } : {}),
          ...(turnCompletedAt === undefined ? {} : { turnCompletedAt })
        })}\x07`
      )
    const snapshot = (version: number, state: 'working' | 'done', turnCompletedAt?: number) => {
      const next = hostSnapshot(version)
      const row = next.tabs[0].agentStatus!
      Object.assign(row, {
        state,
        prompt: 'finish the turn',
        updatedAt: Date.now(),
        stateStartedAt: Date.now(),
        ...(state === 'done' ? { lastAssistantMessage: 'Done.' } : {})
      })
      if (turnCompletedAt !== undefined) {
        next.tabs[0].turnCompletedAt = turnCompletedAt
      }
      return next
    }
    return { store, policy, report, snapshot, apply, requests, mobile, native }
  }

  it('preserves main mirror-only legacy BEL timing without inventing a pane hold', () => {
    const h = setup(true)
    try {
      h.apply(h.snapshot(2, 'working'))
      vi.advanceTimersByTime(10)
      h.apply(h.snapshot(3, 'done'))
      h.policy.callbacks.onBell()
      vi.advanceTimersByTime(250)
      expect(h.requests).toHaveBeenCalledTimes(1)
      expect(h.requests.mock.calls[0]?.[0].source).toBe('terminal-bell')
      vi.advanceTimersByTime(1_250)
      expect(h.requests).toHaveBeenCalledTimes(2)
      expect(h.requests.mock.calls[1]?.[0].source).toBe('agent-task-complete')
      expect(h.store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe('done')
    } finally {
      h.policy.dispose()
    }
  })

  it.each([true, false])(
    'composes live raw and accepted host completion, quiet reconnect and late successor reports (desktop=%s)',
    (desktop) => {
      const h = setup(desktop)
      try {
        const beforeProgram = h.store.getState().agentStatusByPaneKey[PANE_KEY]
        h.policy.observeLegacyData('\x1b]7501;state=working:app=claude\x1b\\')
        h.policy.observeLegacyData('\x1b]7501;state=idle:app=claude\x1b\\')
        h.policy.observeLegacyData('\x1b]7501;state=clear\x1b\\')
        vi.advanceTimersByTime(3_500)
        expect(h.requests).not.toHaveBeenCalled()
        expect(h.store.getState().agentStatusByPaneKey[PANE_KEY]).toBe(beforeProgram)
        h.report('working')
        h.apply(h.snapshot(2, 'working'))
        vi.advanceTimersByTime(100)
        const completedAt = Date.now()
        // A real shared turn stamp, not prompt text or arrival time, identifies this completion.
        h.report('done', completedAt)
        const done = h.snapshot(3, 'done', completedAt)
        h.apply(done)
        h.policy.callbacks.onBell()
        vi.advanceTimersByTime(3_500)
        expect(h.mobile).toHaveBeenCalledTimes(desktop ? 1 : 2)
        expect(h.mobile).toHaveBeenCalledWith(
          expect.objectContaining({
            source: 'agent-task-complete',
            agentState: 'done',
            ...(!desktop ? { desktopAllowed: false } : {})
          })
        )
        // Disabling completion banners preserves the independently enabled bare-BEL path.
        expect(h.native).toHaveBeenCalledTimes(1)
        expect(h.requests).toHaveBeenCalledTimes(desktop ? 1 : 2)
        expect(
          h.requests.mock.calls.filter(([request]) => request.source === 'agent-task-complete')
        ).toHaveLength(1)
        const accepted = h.store.getState().agentStatusByPaneKey[PANE_KEY]
        // An unchanged reconnect projection and historical bytes cannot replay a completion.
        h.apply({ ...done, snapshotVersion: 4 }, false)
        h.policy.legacySource.observeFacts({
          ptyId: `remote:${ENV}@@terminal-1`,
          seq: 1,
          replay: true,
          facts: [
            { kind: 'agent-status', payload: { state: 'done', prompt: '', agentType: 'claude' } }
          ]
        })
        const current = new TerminalSnapshotState()
        current.record({
          kind: 'agent-status',
          payload: { state: 'done', prompt: '', agentType: 'claude' }
        })
        h.policy.restoreCurrent(current.snapshot().current, true)
        vi.advanceTimersByTime(3_500)
        expect(h.requests).toHaveBeenCalledTimes(desktop ? 1 : 2)
        expect(h.store.getState().agentStatusByPaneKey[PANE_KEY]).toEqual(accepted)
        const held = captureTerminalFactSubject(PANE_KEY)
        h.apply(h.snapshot(5, 'working'))
        const successor = h.store.getState().agentStatusByPaneKey[PANE_KEY]
        h.policy.legacySource.observeFacts(
          {
            ptyId: `remote:${ENV}@@terminal-1`,
            seq: 2,
            facts: [
              { kind: 'agent-status', payload: { state: 'done', prompt: '', agentType: 'claude' } }
            ]
          },
          held
        )
        vi.advanceTimersByTime(3_500)
        expect(h.requests).toHaveBeenCalledTimes(desktop ? 1 : 2)
        expect(h.store.getState().agentStatusByPaneKey[PANE_KEY]).toBe(successor)
        // Unstamped old hosts have no shared turn identity: the existing delivery cooldown
        // coalesces their two candidates without manufacturing an identity or dropping either input.
        h.report('working')
        vi.advanceTimersByTime(100)
        h.report('done')
        h.apply(h.snapshot(6, 'done'))
        const legacyDone = h.store.getState().agentStatusByPaneKey[PANE_KEY]
        vi.advanceTimersByTime(3_500)
        expect(
          h.requests.mock.calls.filter(([request]) => request.source === 'agent-task-complete')
        ).toHaveLength(3)
        expect(h.mobile).toHaveBeenCalledTimes(desktop ? 2 : 3)
        expect(h.native).toHaveBeenCalledTimes(desktop ? 2 : 1)
        expect(h.store.getState().agentStatusByPaneKey[PANE_KEY]).toBe(legacyDone)
      } finally {
        h.policy.dispose()
      }
    }
  )
})
