/** Paired panes receive both client byte-derived status/titles and host snapshot echoes. Proven client ownership must fence stale echoes despite cross-machine clocks; teardown returns authority and host-only states pierce the fence. Drive real mirror/store logic with controlled clocks and assert transition order/count, including generatedLabel and epoch stability. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { AppState } from '../../../store/types'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import {
  markRendererOwnedAgentStatusWrite,
  registerRendererOwnedAgentStatusPane,
  resetRendererOwnedAgentStatusPanesForTests,
  resolveRendererOwnedAgentStatusTiming
} from '../../../components/terminal-pane/agent-status/renderer-owned-agent-status-registry'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import { shouldApplyWebSessionTabsSnapshot } from '../tracking-decisions'

// Mirror imports app singleton; redirect it to this createTestStore harness.
vi.mock('../../../store/index', () => ({
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
const CLIENT_PROMPT = 'Configurar y entender los comprobantes electronicos del sistema'

const LOCAL_WT = 'repo1::/path/local-wt'

type TestStore = ReturnType<typeof createTestStore>

function makeHostSnapshot(args: {
  snapshotVersion: number
  hostNow: number
  includeAgentStatus: boolean
  agentStatusOverrides?: Partial<AgentStatusEntry>
  aiVaultTitle?: { agent: 'claude'; sessionId: string; title: string } | null
  resolvesSessionTitle?: true
  title?: string
  status?: 'ready' | 'pending-handle'
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
        title: args.title ?? 'Terminal',
        parentTabId: HOST_TAB_ID,
        leafId: LEAF_ID,
        isActive: true,
        ...(args.status === 'pending-handle'
          ? { status: 'pending-handle' as const, terminal: null }
          : { status: 'ready' as const, terminal: 'terminal-1' }),
        ...(args.aiVaultTitle !== undefined ? { aiVaultTitle: args.aiVaultTitle } : {}),
        ...(args.resolvesSessionTitle ? { resolvesSessionTitle: true as const } : {}),
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
      resolveRendererOwnedAgentStatusTiming(
        store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)
      ),
      { tabId: MIRROR_TAB_ID, worktreeId: WT }
    )
  return release
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

  // Fence only proven client writers and never host-only state classes.
  describe('authority handback', () => {
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
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)?.state).toBe('waiting')

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
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)?.state).toBe('working')

      replayClientOscWorking(store, T0 + 1_500)
      const byteEntry = store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)
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
      expect(store.getState().agentStatusByPaneKey.get(MIRROR_PANE_KEY)).toMatchObject({
        state: 'working',
        updatedAt: T0 + 1_500,
        prompt: CLIENT_PROMPT
      })
    })
  })
})
