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
import { applyFreshWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    getState: vi.fn(() => ({})),
    subscribe: vi.fn(() => () => {})
  }
}))

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

  afterEach(() => {
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
