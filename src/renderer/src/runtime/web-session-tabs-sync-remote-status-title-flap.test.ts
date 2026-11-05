/** Paired panes receive both client byte-derived status/titles and host snapshot echoes. Proven client ownership must fence stale echoes despite cross-machine clocks; teardown returns authority and host-only states pierce the fence. Drive real mirror/store logic with controlled clocks and assert transition order/count, including generatedLabel and epoch stability. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/workspace-layout/terminal-surface-id'
import { deriveGeneratedTabTitle } from '../../../shared/agent-status/presentation/agent-tab-title'
import { getDefaultSettings } from '../../../shared/constants'
import { resolveTerminalTabTitle } from '../../../shared/tab-title-resolution'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests,
  resolveRendererOwnedAgentStatusTiming
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import { shouldApplyWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'

// Mirror imports app singleton; redirect it to this createTestStore harness.
vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

const WT = 'repo1::/path/wt1'
const ENV = 'web-env-1'
const HOST_TAB_ID = 'host-tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_SURFACE_ID = `${HOST_TAB_ID}::${LEAF_ID}`
const MIRROR_TAB_ID = toWebTerminalSurfaceTabId(HOST_TAB_ID)
const MIRROR_PANE_KEY = makePaneKey(MIRROR_TAB_ID, LEAF_ID)
const HOST_PANE_KEY = makePaneKey(HOST_TAB_ID, LEAF_ID)
const T0 = 1_700_000_000_000
const CYCLES = 3
const CLIENT_PROMPT = 'Configurar y entender los comprobantes electronicos del sistema'
const EXPECTED_GENERATED_TITLE = deriveGeneratedTabTitle(CLIENT_PROMPT)!

const LOCAL_WT = 'repo1::/path/local-wt'
const LOCAL_PANE_KEY = makePaneKey('local-tab-1', LEAF_ID)

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  includeAgentStatus: boolean
  agentStatusOverrides?: Partial<AgentStatusEntry>
  aiVaultTitle?: { agent: 'claude'; sessionId: string; title: string }
}): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'host-epoch-1',
    snapshotVersion: args.snapshotVersion,
    activeGroupId: 'host-group-1',
    activeTabId: HOST_SURFACE_ID,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        ...(args.aiVaultTitle ? { aiVaultTitle: args.aiVaultTitle } : {}),
        ...(args.includeAgentStatus
          ? {
              agentStatus: {
                state: 'done' as const,
                prompt: '',
                updatedAt: args.hostNow,
                stateStartedAt: args.hostNow - 1_000,
                agentType: 'claude' as const,
                paneKey: HOST_PANE_KEY,
                tabId: HOST_TAB_ID,
                worktreeId: WT,
                stateHistory: [],
                ...args.agentStatusOverrides
              }
            }
          : {})
      }
    ]
  }
}

/** Mirrors applyWebSessionTabsStorePatch: build the patch from live state, then setState it. */
function applyHostSnapshot(
  store: TestStore,
  snapshot: RuntimeMobileSessionTabsResult,
  now: number
): void {
  const state = store.getState()
  // The freshness gate must accept every republished frame (monotonic version).
  expect(shouldApplyWebSessionTabsSnapshot(snapshot, ENV)).toBe(true)
  const patch = applyWebSessionTabsSnapshot(state, snapshot, ENV, now)
  store.setState(patch as Partial<AppState>)
}

/** Replay paired pty-connection OSC handling with client Date.now(); returns the release pty-connection holds for dispose(). */
function replayClientOscWorking(store: TestStore, clientNow: number): () => void {
  vi.setSystemTime(clientNow)
  // Claim on transport creation, then verify ownership on each byte-derived status.
  const release = registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      MIRROR_PANE_KEY,
      { state: 'working', prompt: CLIENT_PROMPT, agentType: 'claude' },
      'claude',
      resolveRendererOwnedAgentStatusTiming(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]),
      { tabId: MIRROR_TAB_ID, worktreeId: WT }
    )
  return release
}

type Frame = {
  source: string
  statusState: string | null
  tabGeneratedTitle: string | null
  visibleTabBarLabel: string | null
  unifiedGeneratedLabel: string | null
  unifiedLabel: string | null
  agentStatusEpoch: number
}

function captureFrame(store: TestStore, source: string): Frame {
  const s = store.getState()
  const tab = (s.tabsByWorktree[WT] ?? []).find((t) => t.id === MIRROR_TAB_ID)
  const unified = (s.unifiedTabsByWorktree[WT] ?? []).find((t) => t.id === MIRROR_TAB_ID)
  return {
    source,
    statusState: s.agentStatusByPaneKey[MIRROR_PANE_KEY]?.state ?? null,
    tabGeneratedTitle: tab?.generatedTitle ?? null,
    visibleTabBarLabel: tab?.generatedTitle ?? tab?.title ?? null,
    unifiedGeneratedLabel: unified?.generatedLabel ?? null,
    unifiedLabel: unified?.label ?? null,
    agentStatusEpoch: s.agentStatusEpoch
  }
}

function countTransitions(values: (string | null)[]): number {
  let transitions = 0
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] !== values[i - 1]) {
      transitions += 1
    }
  }
  return transitions
}

function seedPairedClientStore(): TestStore {
  const store = createTestStore()
  seedStore(store, {
    settings: {
      ...getDefaultSettings('/tmp'),
      tabAutoGenerateTitle: true
    },
    worktreesByRepo: {
      repo1: [
        // The paired server owns this workspace, so its titles stay the window's to apply.
        makeWorktree({
          id: WT,
          repoId: 'repo1',
          path: '/path/wt1',
          runtimeOwnerEnvironmentId: ENV
        }),
        makeWorktree({ id: LOCAL_WT, repoId: 'repo1', path: '/path/local-wt' })
      ]
    },
    activeWorktreeId: WT
  })
  return store
}

/** Interleave host/client publications with advancing controlled clocks and no skew; capture each resulting frame. */
function runDualPublicationCycles(store: TestStore, includeAgentStatus: boolean): Frame[] {
  applyHostSnapshot(
    store,
    makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 - 1_000, includeAgentStatus }),
    T0
  )
  const frames: Frame[] = [captureFrame(store, 'host-snapshot-1')]
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    replayClientOscWorking(store, T0 + cycle * 1_000 - 500)
    frames.push(captureFrame(store, `client-osc-${cycle}`))
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1 + cycle,
        hostNow: T0 + cycle * 1_000,
        includeAgentStatus
      }),
      T0 + cycle * 1_000
    )
    frames.push(captureFrame(store, `host-snapshot-${1 + cycle}`))
  }
  return frames
}

describe('remote-paired pane: host snapshot mirror vs client byte-derived status/title (issue1-ui-flash)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  describe('converged sequence pinned (inverted defect pins — deterministic post-fix)', () => {
    it('settles on the client-owned status and generated label and stops flipping on republication', () => {
      const store = seedPairedClientStore()
      expect(EXPECTED_GENERATED_TITLE).toBeTruthy()

      store
        .getState()
        .setAgentStatus(
          LOCAL_PANE_KEY,
          { state: 'working', prompt: 'unrelated local work', agentType: 'codex' },
          undefined,
          { updatedAt: T0 - 10_000 },
          { tabId: 'local-tab-1', worktreeId: LOCAL_WT }
        )
      const localEntryBefore = store.getState().agentStatusByPaneKey[LOCAL_PANE_KEY]
      expect(localEntryBefore?.state).toBe('working')

      const frames = runDualPublicationCycles(store, true)

      // Host owns until the first byte write; later echoes must be no-ops including unified generatedLabel.
      const expectedFrames: Partial<Frame>[] = [
        {
          source: 'host-snapshot-1',
          statusState: 'done',
          tabGeneratedTitle: null,
          visibleTabBarLabel: 'Terminal',
          unifiedGeneratedLabel: null,
          unifiedLabel: 'Terminal'
        }
      ]
      for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
        for (const source of [`client-osc-${cycle}`, `host-snapshot-${1 + cycle}`]) {
          expectedFrames.push({
            source,
            statusState: 'working',
            tabGeneratedTitle: EXPECTED_GENERATED_TITLE,
            visibleTabBarLabel: EXPECTED_GENERATED_TITLE,
            unifiedGeneratedLabel: EXPECTED_GENERATED_TITLE,
            unifiedLabel: 'Terminal'
          })
        }
      }
      expect(frames.map(({ agentStatusEpoch: _epoch, ...frame }) => frame)).toEqual(expectedFrames)
      expect(countTransitions(frames.map((f) => f.statusState))).toBe(1)
      expect(countTransitions(frames.map((f) => f.visibleTabBarLabel))).toBe(1)

      // No-op echoes must not bump agent-status epoch and trigger render/sort churn.
      for (const [index, frame] of frames.entries()) {
        if (frame.source.startsWith('host-snapshot-') && index > 0) {
          expect(frame.agentStatusEpoch, frame.source).toBe(frames[index - 1]!.agentStatusEpoch)
        }
      }

      // Negative safety: the unrelated local pane survives all mirror cycles untouched.
      expect(store.getState().agentStatusByPaneKey[LOCAL_PANE_KEY]).toEqual(localEntryBefore)
    })
  })

  // Fence only proven client writers and never host-only state classes.
  describe('authority handback', () => {
    it('cedes back to the host once the pane is torn down', () => {
      const store = seedPairedClientStore()
      const release = replayClientOscWorking(store, T0 + 500)
      release()

      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 2, hostNow: T0 + 1_000, includeAgentStatus: true }),
        T0 + 1_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('done')

      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 3, hostNow: T0 + 2_000, includeAgentStatus: false }),
        T0 + 2_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]).toBeUndefined()
    })

    // Staleness decays client status to idle rather than deleting it (STA-3107); host omission offers no replacement. Only teardown hands authority back, so waking clients retain their rows.
    it('decays rather than deletes a client "working" the agent never closed', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      const afterStale = T0 + AGENT_STATUS_STALE_AFTER_MS + 1
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 2, hostNow: afterStale, includeAgentStatus: false }),
        afterStale
      )

      const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      expect(entry).toBeDefined()
      expect(
        isExplicitAgentStatusFresh(entry!, afterStale, AGENT_STATUS_STALE_AFTER_MS),
        'the retained entry must read as stale so consumers render it idle'
      ).toBe(false)
    })

    it('follows behind-clock host continuation and completion after an HTTP approval', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: T0 - 60_000,
          includeAgentStatus: true,
          agentStatusOverrides: {
            state: 'waiting',
            interactivePrompt: 'Allow exec_command?'
          }
        }),
        T0 + 1_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]).toMatchObject({
        state: 'waiting',
        mirroredEvidenceReceivedAt: T0 + 1_000
      })

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 3,
          hostNow: T0 - 59_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'working' }
        }),
        T0 + 2_000
      )
      const continued = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      expect(continued?.state).toBe('working')
      expect(continued?.interactivePrompt).toBeUndefined()

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 4,
          hostNow: T0 - 58_000,
          includeAgentStatus: true
        }),
        T0 + 3_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('done')

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 5,
          hostNow: T0 - 57_000,
          includeAgentStatus: false
        }),
        T0 + 4_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]).toBeUndefined()
    })

    it('reclaims byte ownership after approval despite an ahead-clock host', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: T0 + 60_000,
          includeAgentStatus: true,
          agentStatusOverrides: {
            state: 'waiting',
            interactivePrompt: 'Allow exec_command?'
          }
        }),
        T0 + 1_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('waiting')

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 3,
          hostNow: T0 + 61_000,
          includeAgentStatus: true,
          agentStatusOverrides: { state: 'working' }
        }),
        T0 + 1_250
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      replayClientOscWorking(store, T0 + 1_500)
      const byteEntry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      expect(byteEntry?.state).toBe('working')
      expect(byteEntry?.mirroredEvidenceReceivedAt).toBeUndefined()
      expect(byteEntry?.interactivePrompt).toBeUndefined()

      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 4,
          hostNow: T0 + 120_000,
          includeAgentStatus: true
        }),
        T0 + 2_000
      )
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]).toMatchObject({
        state: 'working',
        updatedAt: T0 + 1_500,
        prompt: CLIENT_PROMPT
      })
    })
  })
})

describe('remote-paired pane: host session name', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetRendererOwnedAgentStatusPanesForTests()
  })

  it('labels the mirrored tab with the host session name over the client first-prompt title', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({ snapshotVersion: 1, hostNow: T0, includeAgentStatus: true }),
      T0
    )
    replayClientOscWorking(store, T0 + 1_000)()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostNow: T0 + 2_000,
        includeAgentStatus: true,
        aiVaultTitle: { agent: 'claude', sessionId: 'session-1', title: 'Login cleanup' }
      }),
      T0 + 2_000
    )

    const tab = (store.getState().tabsByWorktree[WT] ?? []).find((t) => t.id === MIRROR_TAB_ID)
    expect(tab?.generatedTitle).toBe(EXPECTED_GENERATED_TITLE)
    expect(resolveTerminalTabTitle(tab!, true)).toBe('Login cleanup')
  })

  it('keeps the client name for a session it tracks so a stale host snapshot cannot revert a rename', () => {
    const store = seedPairedClientStore()
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 1,
        hostNow: T0,
        includeAgentStatus: true,
        aiVaultTitle: { agent: 'claude', sessionId: 'session-1', title: 'Old' }
      }),
      T0
    )
    store
      .getState()
      .setAiVaultTabTitle(MIRROR_TAB_ID, { agent: 'claude', sessionId: 'session-1', title: 'New' })
    applyHostSnapshot(
      store,
      makeHostSnapshot({
        snapshotVersion: 2,
        hostNow: T0 + 1_000,
        includeAgentStatus: true,
        aiVaultTitle: { agent: 'claude', sessionId: 'session-1', title: 'Old' }
      }),
      T0 + 1_000
    )

    const tab = (store.getState().tabsByWorktree[WT] ?? []).find((t) => t.id === MIRROR_TAB_ID)
    expect(tab?.aiVaultTitle?.title).toBe('New')
  })
})
