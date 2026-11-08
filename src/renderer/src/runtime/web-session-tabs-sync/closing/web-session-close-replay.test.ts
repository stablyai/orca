// STA-6224: a user's close the paired host never received must be sent again, not dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import '../../../../../shared/workspace-layout/paired-terminal-tab-close-intent'

import {
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests
} from './web-session-close-replay'
import { recordReceivedWebSessionTabsSnapshot } from '../tracking'
import './web-session-close-intent'
import { applyWebSessionTabsSnapshot } from '../snapshot-api'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import { appPairedTerminalTabCloseIntentStore as STORE } from './paired-terminal-tab-close-intent-store'
import {
  createPairedTerminalTabCloseIntentTestStore,
  type PairedTerminalTabCloseIntentTestStore
} from '../../../store/terminals/paired-terminal-tab-close-intent.test-fixture'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'

const { replayWebSessionTabCloses, intentStore } = vi.hoisted(() => {
  const holder: { current?: PairedTerminalTabCloseIntentTestStore } = {}
  return { replayWebSessionTabCloses: vi.fn(async () => {}), intentStore: holder }
})

vi.mock('../../../store/index', () => ({
  useAppStore: {
    setState: vi.fn(),
    // The held closes are the only store state this suite reads.
    getState: () => intentStore.current?.getState()
  }
}))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
vi.mock('../actions/web-runtime-session-tab-lifecycle', () => ({ replayWebSessionTabCloses }))

const OWNER = { environmentId: ENV, pairingRevision: 1 }
const SURFACE = {
  type: 'terminal' as const,
  id: HOST_SURFACE_ID,
  parentTabId: 'host-tab-1',
  leafId: LEAF_ID,
  title: 'Terminal',
  status: 'ready' as const,
  terminal: 'term_host',
  isActive: true
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  intentStore.current = createPairedTerminalTabCloseIntentTestStore()
  replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 1 }])
})
afterEach(() => {
  resetWebSessionCloseReplaysForTests()
  replaceRuntimeEnvironmentRevisions([])
  replayWebSessionTabCloses.mockClear()
  vi.useRealTimers()
})

describe('web session close replay', () => {
  it('sends the held close when a host snapshot arrives, while keeping the tab hidden', async () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    const snapshot = makeSnapshot([SURFACE])

    // Receipt, not apply: the reconnect snapshot is unchanged, so it may never be applied.
    recordReceivedWebSessionTabsSnapshot(ENV, snapshot)
    const patch = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV, NOW)

    expect((patch.tabsByWorktree?.[WT] ?? []).map((tab) => tab.id)).not.toContain(
      toWebTerminalSurfaceTabId('host-tab-1')
    )
    await vi.waitFor(() => expect(replayWebSessionTabCloses).toHaveBeenCalledOnce())
    expect(replayWebSessionTabCloses).toHaveBeenCalledWith(ENV, [
      expect.objectContaining({ worktreeId: WT, hostTabIds: ['host-tab-1'] })
    ])
  })
})
