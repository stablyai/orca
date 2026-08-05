/**
 * issue1-ui-flash repro: on a paired client viewing a remote-runtime worktree,
 * TWO independent writers own the same store keys for one mirrored pane:
 *
 *  A) the client's own byte-derived pipeline (renderer owns agent status for
 *     remote panes: pty-connection.ts `shouldOwnAgentStatusInRenderer =
 *     runtimeEnvironmentId !== null`): setAgentStatus('working', prompt) ->
 *     setGeneratedTabTitleFromAgentPrompt writes agentStatusByPaneKey +
 *     tab.generatedTitle (+ unified generatedLabel), all client-clock stamped;
 *  B) the host `session.tabs` snapshot mirror (applyWebSessionTabsSnapshot):
 *     every accepted snapshot REBUILDS the mirrored TerminalTab (dropping the
 *     client-set generatedTitle — buildMirroredTerminalTabs carries only
 *     default/custom title, color, pin, viewMode) and last-write-wins-merges
 *     agentStatus by cross-machine wall-clock updatedAt (or DELETES the client
 *     entry outright when the host surface carries none).
 *
 * Neither writer is authoritative, so while both keep publishing (the host
 * republishes on any host store change; client OSC/hook heartbeats keep
 * firing) the client UI alternates between frame A ("Configurar y entender
 * ..." + working) and frame B ("Terminal" + "Done - Claude") indefinitely —
 * the flash in the user screenshots. The tab bar renders terminal titles from
 * tabsByWorktree via resolveTerminalTabTitle (TabBar.tsx:1037), so
 * tab.generatedTitle is the VISIBLE label source that flaps.
 *
 * Suite layout:
 *  - "single-authority invariant" tests assert convergence. This is the fix
 *    gate (RED before the client-authority fence existed).
 *  - "converged sequence pinned" tests were the inverted defect pins: same
 *    harness, same controlled clocks, now asserting the exact post-fix store
 *    sequence (one transition, then stability) instead of the alternation.
 *  - "authority handback" tests cover the other direction: a pane the client
 *    does NOT own (never wrote / torn down / gone stale) still cedes to the
 *    host, and host-only state classes still pierce the fence.
 *
 * The fix is a client-authority fence keyed by pane: pty-connection registers
 * the pane when `shouldOwnAgentStatusInRenderer` is decided and marks a write
 * on each byte-derived status, so `replayClientOscWorking` below does both —
 * that is what the renderer really does for a remote pane.
 *
 * Clocks are injected everywhere (vi.setSystemTime + explicit snapshot
 * timestamps); timing is never the oracle — transition counts/ordering are.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { deriveGeneratedTabTitle } from '../../../shared/agent-tab-title'
import { getDefaultSettings } from '../../../shared/constants'
import type { AppState } from '../store/types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests
} from '../components/terminal-pane/renderer-owned-agent-status-registry'
import {
  applyFreshWebSessionTabsSnapshot,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'

// Why: web-session-tabs-sync imports the app-level store singleton; this
// harness drives a createTestStore instance instead, like the sibling suite.
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
// The prompt Claude is running on the host (user screenshot: "Configurar y entender ...").
const CLIENT_PROMPT = 'Configurar y entender los comprobantes electronicos del sistema'
const EXPECTED_GENERATED_TITLE = deriveGeneratedTabTitle(CLIENT_PROMPT)!

// Unrelated local pane that must survive every mirror cycle untouched.
const LOCAL_WT = 'repo1::/path/local-wt'
const LOCAL_PANE_KEY = makePaneKey('local-tab-1', LEAF_ID)

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  includeAgentStatus: boolean
  agentStatusOverrides?: Partial<AgentStatusEntry>
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
        // Host has no generated title for this pane, so its resolved surface
        // title is the plain default (frame B in the screenshots).
        title: 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        status: 'ready',
        terminal: 'terminal-1',
        ...(args.includeAgentStatus
          ? {
              // Host hook projection: the turn looks finished from the host's
              // point of view ("Done - Claude" in the sidebar, frame B).
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
  const patch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, now)
  // The freshness gate must accept every republished frame (monotonic version).
  expect(patch).not.toBe(state)
  store.setState(patch as Partial<AppState>)
}

/**
 * Byte-identical replay of what the client renderer does for a remote pane on
 * a Claude status OSC (pty-connection.ts handleRendererOwnedAgentStatus with
 * shouldOwnAgentStatusInRenderer = runtimeEnvironmentId !== null): timing is
 * undefined, so updatedAt is the CLIENT's Date.now().
 */
/** Returns the pane's release, as pty-connection holds it for dispose(). */
function replayClientOscWorking(store: TestStore, clientNow: number): () => void {
  vi.setSystemTime(clientNow)
  // Exactly what pty-connection does for a remote pane: claim the pane once at
  // transport creation, then prove the claim on every byte-derived status.
  const release = registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
  markRendererOwnedAgentStatusWrite(MIRROR_PANE_KEY)
  store
    .getState()
    .setAgentStatus(
      MIRROR_PANE_KEY,
      { state: 'working', prompt: CLIENT_PROMPT, agentType: 'claude' },
      'claude',
      undefined,
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
    // What the tab bar shows: resolveTerminalTabTitle precedence for this
    // fixture reduces to generatedTitle || title.
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
        makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: LOCAL_WT, repoId: 'repo1', path: '/path/local-wt' })
      ]
    },
    activeWorktreeId: WT
  } as Partial<AppState>)
  return store
}

/**
 * Drives the dual-publication interleaving with fully controlled clocks:
 * host and client each keep emitting with normally advancing timestamps
 * (zero cross-machine skew required). Returns one frame per publication.
 */
function runDualPublicationCycles(store: TestStore, includeAgentStatus: boolean): Frame[] {
  applyHostSnapshot(
    store,
    makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 - 1_000, includeAgentStatus }),
    T0
  )
  const frames: Frame[] = [captureFrame(store, 'host-snapshot-1')]
  for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
    // Client OSC heartbeat: Claude is mid-turn per the client's byte stream.
    replayClientOscWorking(store, T0 + cycle * 1_000 - 500)
    frames.push(captureFrame(store, `client-osc-${cycle}`))
    // Host republishes (any host store change republishes; the hook row
    // re-delivers `done` with a fresh host wall-clock updatedAt).
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

  describe('single-authority invariant (fix gate — RED on current main)', () => {
    it('agent status and visible tab label converge to one authoritative value under dual publication', () => {
      const store = seedPairedClientStore()
      const frames = runDualPublicationCycles(store, true)
      const evidence = `observed publication frames:\n${JSON.stringify(frames, null, 2)}`

      // Disagreement begins at the first client byte-derived write (frame 1).
      // A single-authority design allows at most one more transition after
      // that (whichever side is authoritative wins and sticks). Current main
      // flips on EVERY publication: 2 * CYCLES status transitions and
      // 2 * CYCLES visible-label transitions.
      const statusTransitionsAfterDisagreement = countTransitions(
        frames.slice(1).map((f) => f.statusState)
      )
      const visibleLabelTransitionsAfterDisagreement = countTransitions(
        frames.slice(1).map((f) => f.visibleTabBarLabel)
      )
      expect(statusTransitionsAfterDisagreement, evidence).toBeLessThanOrEqual(1)
      expect(visibleLabelTransitionsAfterDisagreement, evidence).toBeLessThanOrEqual(1)
    })

    it('a host surface without agentStatus does not delete the client-owned fresher live entry', () => {
      const store = seedPairedClientStore()
      // Initial mirror: host publishes the pane with NO hook status at all.
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 1, hostNow: T0, includeAgentStatus: false }),
        T0
      )
      // Client byte pipeline: agent is working; client clock strictly AHEAD of
      // anything the host ever published, so no freshness rule can justify a wipe.
      replayClientOscWorking(store, T0 + 1_000)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 2, hostNow: T0, includeAgentStatus: false }),
        T0 + 1_500
      )
      const entryAfterMirror = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      // RED on main: buildMirroredAgentStatusPatch deletes the live entry
      // because the host surface carries no agentStatus for the pane key.
      expect(entryAfterMirror?.state, 'host mirror deleted the fresher client live entry').toBe(
        'working'
      )
    })
  })

  describe('converged sequence pinned (inverted defect pins — deterministic post-fix)', () => {
    it('settles on the client-owned status and generated label and stops flipping on republication', () => {
      const store = seedPairedClientStore()
      expect(EXPECTED_GENERATED_TITLE).toBeTruthy()

      // Unrelated local pane written by the local pipeline; must never be touched.
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

      // Exact post-fix sequence: the host frame owns the pane until the client's
      // byte pipeline claims it, and every later republication is a no-op —
      // including the unified generatedLabel, which now tracks the terminal tab
      // instead of diverging behind the equality bail.
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

      // No re-render/re-sort churn: a host republication that changes nothing
      // must not bump the global agent-status epoch.
      for (const [index, frame] of frames.entries()) {
        if (frame.source.startsWith('host-snapshot-') && index > 0) {
          expect(frame.agentStatusEpoch, frame.source).toBe(frames[index - 1]!.agentStatusEpoch)
        }
      }

      // Negative safety: the unrelated local pane survives all mirror cycles untouched.
      expect(store.getState().agentStatusByPaneKey[LOCAL_PANE_KEY]).toEqual(localEntryBefore)
    })

    it('keeps the client live status and generated title when the host surface has no agentStatus', () => {
      const store = seedPairedClientStore()
      const frames = runDualPublicationCycles(store, false)

      // The hook-only host publishes nothing for an OSC-driven pane; that is not
      // proof the agent stopped, so the client entry survives every cycle.
      const statusSequence = frames.map((f) => f.statusState)
      expect(statusSequence).toEqual([
        null,
        'working',
        'working',
        'working',
        'working',
        'working',
        'working'
      ])
      expect(countTransitions(statusSequence)).toBe(1)
      expect(frames.map((f) => f.tabGeneratedTitle)).toEqual([
        null,
        ...Array.from({ length: 2 * CYCLES }, () => EXPECTED_GENERATED_TITLE)
      ])
    })
  })

  // The fence must be narrow: it only holds while THIS renderer is proving it
  // owns the pane's bytes, and it never hides host-only state classes.
  describe('authority handback', () => {
    it('does not fence a pane that claimed authority but never wrote byte-derived status', () => {
      const store = seedPairedClientStore()
      registerRendererOwnedAgentStatusPane(MIRROR_PANE_KEY, ENV)
      store
        .getState()
        .setAgentStatus(
          MIRROR_PANE_KEY,
          { state: 'working', prompt: CLIENT_PROMPT, agentType: 'claude' },
          'claude',
          { updatedAt: T0 },
          { tabId: MIRROR_TAB_ID, worktreeId: WT }
        )

      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 1, hostNow: T0 + 1_000, includeAgentStatus: true }),
        T0 + 1_000
      )

      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('done')
    })

    it('cedes back to the host once the pane is torn down', () => {
      const store = seedPairedClientStore()
      const release = replayClientOscWorking(store, T0 + 500)
      // pty-connection.dispose(): a detached client stops observing the bytes.
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

    it('lets the stale boundary release a client "working" the agent never closed', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0)
      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]?.state).toBe('working')

      // The agent died OSC-silent: no further client write, no host status.
      const afterStale = T0 + AGENT_STATUS_STALE_AFTER_MS + 1
      applyHostSnapshot(
        store,
        makeHostSnapshot({ snapshotVersion: 2, hostNow: afterStale, includeAgentStatus: false }),
        afterStale
      )

      expect(store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]).toBeUndefined()
    })

    it('lets a host permission block pierce the fence (hook-HTTP-only on the host)', () => {
      const store = seedPairedClientStore()
      replayClientOscWorking(store, T0 + 500)

      const blockedAt = T0 + 1_000
      applyHostSnapshot(
        store,
        makeHostSnapshot({
          snapshotVersion: 2,
          hostNow: blockedAt,
          includeAgentStatus: true,
          agentStatusOverrides: {
            state: 'blocked',
            prompt: 'Allow Bash(rm -rf)?',
            interactivePrompt: 'Allow Bash(rm -rf)?'
          }
        }),
        blockedAt
      )

      const entry = store.getState().agentStatusByPaneKey[MIRROR_PANE_KEY]
      expect(entry?.state).toBe('blocked')
      expect(entry?.interactivePrompt).toBe('Allow Bash(rm -rf)?')
    })
  })
})
