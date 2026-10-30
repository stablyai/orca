// STA-6224: a user's close the paired host never received must be sent again, not dropped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import {
  MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS,
  PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS,
  pairedTerminalTabCloseIntentSchema
} from '../../../shared/paired-terminal-tab-close-intent'
import {
  MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS,
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests,
  settleWebSessionCloseReplay,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { recordReceivedWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking'
import { isWebSessionCloseIntentPending } from './web-session-close-intent'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { appPairedTerminalTabCloseIntentStore as STORE } from './paired-terminal-tab-close-intent-store'
import {
  createPairedTerminalTabCloseIntentTestStore,
  type PairedTerminalTabCloseIntentTestStore
} from '../store/terminals/paired-terminal-tab-close-intent.test-fixture'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const { replayWebSessionTabCloses, intentStore } = vi.hoisted(() => {
  const holder: { current?: PairedTerminalTabCloseIntentTestStore } = {}
  return { replayWebSessionTabCloses: vi.fn(async () => {}), intentStore: holder }
})

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn(),
    // The held closes are the only store state this suite reads.
    getState: () => intentStore.current?.getState()
  }
}))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))
vi.mock('./web-runtime-session-tab-lifecycle', () => ({ replayWebSessionTabCloses }))

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
const PRESENT = new Set(['host-tab-1'])

function heldHostTabIds(): string[][] {
  return (STORE.getIntents()?.[ENV] ?? []).map((intent) => intent.hostTabIds)
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
  it('is due once a snapshot shows the host still holds the tab, and not twice in flight', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])

    const [due] = takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)
    expect(due).toMatchObject({ worktreeId: WT, hostTabIds: ['host-tab-1'] })
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])

    expect(settleWebSessionCloseReplay(STORE, due!, true)).toBe('done')
    expect(heldHostTabIds()).toEqual([])
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])
  })

  it('keeps a held close through a snapshot that omits the tab', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])

    // An incomplete inventory omits tabs too, so absence is not proof the host removed it.
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, new Set())).toEqual([])
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toHaveLength(1)
  })

  it('re-hides a tab whose close is in flight when a snapshot lists it again', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)
    resetWebSessionTabsSyncTestState()

    recordReceivedWebSessionTabsSnapshot(ENV, makeSnapshot([SURFACE]))

    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', NOW)).toBe(true)
    expect(replayWebSessionTabCloses).not.toHaveBeenCalled()
  })

  it('gives up after a bounded number of undelivered sends', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    const outcomes: string[] = []
    for (let attempt = 0; attempt < MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS; attempt += 1) {
      const [due] = takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)
      // A repeat failure holds the same close again; it must not reset the attempt count.
      holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
      outcomes.push(settleWebSessionCloseReplay(STORE, due!, false))
    }
    expect(outcomes).toEqual(['retry', 'retry', 'gave-up'])
    expect(heldHostTabIds()).toEqual([])
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])
  })

  it('drops, unsent and unhidden, a close held for a pairing the host no longer has', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 2 }])
    resetWebSessionTabsSyncTestState()

    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])
    expect(heldHostTabIds()).toEqual([])
    expect(isWebSessionCloseIntentPending({ environmentId: ENV }, WT, 'host-tab-1', NOW)).toBe(
      false
    )
  })

  it('keeps, hides and holds back a close while the pairing is not yet known', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSyncTestState()

    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])
    expect(heldHostTabIds()).toEqual([['host-tab-1']])
    expect(isWebSessionCloseIntentPending({ environmentId: ENV }, WT, 'host-tab-1', NOW)).toBe(true)

    replaceRuntimeEnvironmentRevisions([{ id: ENV, createdAt: 0, pairingRevision: 1 }])
    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toHaveLength(1)
  })

  it('saves a held close for a mirrored editor tab named by a long file path', () => {
    const intent = { hostTabIds: [`/${'deep/'.repeat(60)}file.ts`], worktreeId: WT, closedAt: NOW }

    expect(pairedTerminalTabCloseIntentSchema.safeParse(intent).success).toBe(true)
  })

  it('keeps a held close through a snapshot that cannot state the worktree contents', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])

    recordReceivedWebSessionTabsSnapshot(ENV, makeSnapshot([], { publicationEpoch: 'none' }))

    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toHaveLength(1)
  })

  it('holds at most the cap per environment and stops hiding an evicted close', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-0'])
    for (let index = 1; index <= MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS; index += 1) {
      holdWebSessionCloseForReplay(STORE, OWNER, WT, [`host-tab-${index}`])
    }

    expect(heldHostTabIds()).toHaveLength(MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS)
    expect(heldHostTabIds()[0]).toEqual(['host-tab-1'])
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-0', NOW)).toBe(false)
  })

  it('shows again a tab whose expired close another settlement prunes', () => {
    vi.useFakeTimers({ now: NOW })
    holdWebSessionCloseForReplay(STORE, OWNER, 'other-worktree', ['host-tab-9'])
    vi.setSystemTime(NOW + PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS + 1)
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    const [due] = takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)

    expect(settleWebSessionCloseReplay(STORE, due!, true)).toBe('done')

    expect(heldHostTabIds()).toEqual([])
    expect(isWebSessionCloseIntentPending(OWNER, 'other-worktree', 'host-tab-9', Date.now())).toBe(
      false
    )
    // The delivered close keeps hiding its tab until the host's snapshot drops it.
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', Date.now())).toBe(true)
  })

  it('shows the tab again once the host keeps refusing the close', () => {
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    for (let attempt = 1; attempt < MAX_WEB_SESSION_CLOSE_REPLAY_ATTEMPTS; attempt += 1) {
      settleWebSessionCloseReplay(
        STORE,
        takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)[0]!,
        false
      )
    }
    const [last] = takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)

    expect(settleWebSessionCloseReplay(STORE, last!, false)).toBe('gave-up')
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', NOW)).toBe(false)
  })

  it('drops a close past the age bound instead of sending it', () => {
    vi.useFakeTimers({ now: NOW })
    holdWebSessionCloseForReplay(STORE, OWNER, WT, ['host-tab-1'])
    vi.setSystemTime(NOW + PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS + 1)

    expect(takeDueWebSessionCloseReplays(STORE, ENV, WT, PRESENT)).toEqual([])
    expect(heldHostTabIds()).toEqual([])
    expect(isWebSessionCloseIntentPending(OWNER, WT, 'host-tab-1', Date.now())).toBe(false)
  })

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
