import { afterEach, describe, expect, it } from 'vitest'
import { WEB_SESSION_TABS_RPC_TIMEOUT_MS } from '../../runtime/web-session-tabs-sync'
import {
  markHostSessionMirrorWorktreeHydrated,
  resetHostSessionMirrorHydrationForTests
} from '../../runtime/host-session-mirror-hydration'
import {
  applyRestoredTerminalSpawnHold,
  planRestoredTerminalSpawnHold,
  readRestoredSpawnHoldEvidence,
  RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS,
  RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS,
  willRestoredTabSpawnHostTerminal,
  type RestoredSpawnHoldEntry,
  type RestoredSpawnHoldPaneState,
  type RestoredSpawnHoldTab
} from './restored-terminal-spawn-hold'

const WORKTREE_ID = 'wt-1'
const ENVIRONMENT_ID = 'env-1'
const GENERATION = 1
const NEXT_GENERATION = 2
const WAITING = { connectionGeneration: GENERATION, hostAnswered: false }
const ANSWERED = { connectionGeneration: GENERATION, hostAnswered: true }
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const TABS: RestoredSpawnHoldTab[] = [
  { id: 'row-1', ptyId: null },
  { id: 'row-2', ptyId: null }
]

function plan(
  overrides: Partial<Parameters<typeof planRestoredTerminalSpawnHold>[0]> = {}
): ReturnType<typeof planRestoredTerminalSpawnHold> {
  return planRestoredTerminalSpawnHold({
    holdByWorktreeId: new Map<string, RestoredSpawnHoldEntry>(),
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    evidence: WAITING,
    isColdActivationPass: true,
    nowMs: 1_000,
    allTabs: TABS,
    wouldSpawnHostTerminal: () => true,
    immediateTabIds: new Set<string>(),
    isTabLive: () => false,
    hasMountedTab: () => false,
    ...overrides
  })
}

function paneState(
  overrides: Partial<RestoredSpawnHoldPaneState> = {}
): RestoredSpawnHoldPaneState {
  return {
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    ...overrides
  } as RestoredSpawnHoldPaneState
}

describe('willRestoredTabSpawnHostTerminal', () => {
  it('is true only for a row with no pty anywhere', () => {
    expect(willRestoredTabSpawnHostTerminal({ id: 'row-1', ptyId: null }, paneState())).toBe(true)
    expect(willRestoredTabSpawnHostTerminal({ id: 'row-1', ptyId: 'pty-1' }, paneState())).toBe(
      false
    )
    // Mirrored rows route to the host-session mirror, which has no create path.
    expect(
      willRestoredTabSpawnHostTerminal({ id: 'web-terminal-1', ptyId: null }, paneState())
    ).toBe(false)
    expect(
      willRestoredTabSpawnHostTerminal(
        { id: 'row-1', ptyId: null },
        paneState({ ptyIdsByTabId: { 'row-1': ['remote:env-1:pty-2'] } })
      )
    ).toBe(false)
    // A persisted layout leaf that still owns a pty attaches instead of spawning.
    expect(
      willRestoredTabSpawnHostTerminal(
        { id: 'row-1', ptyId: null },
        paneState({
          terminalLayoutsByTabId: {
            'row-1': {
              root: null,
              activeLeafId: LEAF_ID,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF_ID]: 'remote:env-1:pty-3' }
            }
          }
        })
      )
    ).toBe(false)
  })
})

describe('restored spawn hold deadline', () => {
  it('outlasts the session.tabs timeout it waits on', () => {
    // A reply at 12s must not lose to a fail-open at 10s.
    expect(RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS).toBeGreaterThan(WEB_SESSION_TABS_RPC_TIMEOUT_MS)
    expect(RESTORED_TERMINAL_SPAWN_HOLD_MAX_TOTAL_MS).toBeGreaterThanOrEqual(
      RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    )
  })
})

describe('planRestoredTerminalSpawnHold', () => {
  it('arms only on the activation pass', () => {
    expect([...plan().heldTabIds]).toEqual(['row-1', 'row-2'])
    expect([...plan({ isColdActivationPass: false }).heldTabIds]).toEqual([])
  })

  it('never holds a carve-out row', () => {
    expect([...plan({ immediateTabIds: new Set(['row-1']) }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ isTabLive: (tabId) => tabId === 'row-1' }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ hasMountedTab: (tabId) => tabId === 'row-1' }).heldTabIds]).toEqual(['row-2'])
    expect([...plan({ wouldSpawnHostTerminal: (tab) => tab.id !== 'row-1' }).heldTabIds]).toEqual([
      'row-2'
    ])
  })

  it('holds nothing on a local, ssh or folder workspace', () => {
    // Those resolve no runtime environment, so the hold can never scope itself.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    const result = plan({ holdByWorktreeId, environmentId: null })
    expect(result.heldTabIds.size).toBe(0)
    expect(holdByWorktreeId.size).toBe(0)
  })

  it('arms before any probe has landed and settles when the answer arrives', () => {
    // Slow startup: workspaceSessionReady is true while runtimeStatus is absent, so
    // the environment still sits at its initial generation.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    const armed = plan({
      holdByWorktreeId,
      evidence: { connectionGeneration: 0, hostAnswered: false }
    })
    expect([...armed.heldTabIds]).toEqual(['row-1', 'row-2'])
    plan({ holdByWorktreeId, evidence: ANSWERED, isColdActivationPass: false, nowMs: 2_000 })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(true)
  })

  it('keeps the clock running through a disconnect instead of restarting it', () => {
    // A dropped connection leaves the generation alone, so an unanswered hold on a
    // merely disconnected workspace still reaches its deadline and fails open.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const disconnected = plan({ holdByWorktreeId, isColdActivationPass: false, nowMs: 2_000 })
    expect([...disconnected.heldTabIds]).toEqual(['row-1', 'row-2'])
    const timedOut = plan({
      holdByWorktreeId,
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
  })

  it('settles at once on evidence already accepted for this connection', () => {
    // Reactivating a worktree the host answered for must not run the storm late.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId, evidence: ANSWERED })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(true)
    const later = plan({
      holdByWorktreeId,
      evidence: ANSWERED,
      isColdActivationPass: false,
      nowMs: 1_000_000
    })
    expect([...later.heldTabIds]).toEqual(['row-1', 'row-2'])
  })

  it('ignores evidence stamped with a previous connection', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    // hostAnswered:false is what the generation-scoped latch reports once the
    // generation moved on, so the earlier answer cannot settle the new window.
    plan({
      holdByWorktreeId,
      evidence: { connectionGeneration: NEXT_GENERATION, hostAnswered: false }
    })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(false)
    const timedOut = plan({
      holdByWorktreeId,
      evidence: { connectionGeneration: NEXT_GENERATION, hostAnswered: false },
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
  })

  it('releases and reports the rows it let go when the workspace stops being paired', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const released = plan({ holdByWorktreeId, environmentId: null })
    expect([...released.releasedTabIds]).toEqual(['row-1', 'row-2'])
    expect(holdByWorktreeId.has(WORKTREE_ID)).toBe(false)
  })

  it('fails open when no answer arrives before the deadline', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const timedOut = plan({
      holdByWorktreeId,
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
    expect([...timedOut.releasedTabIds]).toEqual(['row-1', 'row-2'])
  })

  it('gives a reconnect a fresh window but never waits past the ceiling', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    // A flapping runtime reconnects faster than the window ever expires, so only
    // the ceiling can end this hold.
    const step = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS / 2
    const flap = (generation: number): ReturnType<typeof plan> =>
      plan({
        holdByWorktreeId,
        evidence: { connectionGeneration: generation, hostAnswered: false },
        isColdActivationPass: false,
        nowMs: 1_000 + step * (generation - 1)
      })
    expect([...flap(2).heldTabIds]).toEqual(['row-1', 'row-2'])
    expect(holdByWorktreeId.get(WORKTREE_ID)?.windowStartedAtMs).toBe(1_000 + step)
    for (let generation = 3; generation <= 6; generation++) {
      expect([...flap(generation).heldTabIds]).toEqual(['row-1', 'row-2'])
    }
    expect([...flap(7).heldTabIds]).toEqual([])
  })

  it('gives a workspace that moved hosts a fresh window at the same generation', () => {
    // Per-environment generations: env-2's first connection is not a continuation of env-1's.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const moved = plan({
      holdByWorktreeId,
      environmentId: 'env-2',
      isColdActivationPass: false,
      nowMs: 1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...moved.heldTabIds]).toEqual(['row-1', 'row-2'])
    expect(holdByWorktreeId.get(WORKTREE_ID)?.windowStartedAtMs).toBe(
      1_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    )
  })

  it('never lets one host answer speak for a different host', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId, evidence: ANSWERED })
    const moved = plan({
      holdByWorktreeId,
      environmentId: 'env-2',
      isColdActivationPass: false,
      nowMs: 2_000
    })
    expect(holdByWorktreeId.get(WORKTREE_ID)?.settled).toBe(false)
    expect([...moved.heldTabIds]).toEqual(['row-1', 'row-2'])
    // Inheriting the verdict would leave the rows dark forever on a host that never answered.
    const timedOut = plan({
      holdByWorktreeId,
      environmentId: 'env-2',
      isColdActivationPass: false,
      nowMs: 2_000 + RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS
    })
    expect([...timedOut.heldTabIds]).toEqual([])
  })

  it('still bounds a workspace that keeps moving hosts by the total ceiling', () => {
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId })
    const step = RESTORED_TERMINAL_SPAWN_HOLD_TIMEOUT_MS / 2
    const moveTo = (index: number): ReturnType<typeof plan> =>
      plan({
        holdByWorktreeId,
        environmentId: `env-${index}`,
        isColdActivationPass: false,
        nowMs: 1_000 + step * (index - 1)
      })
    for (let index = 2; index <= 6; index++) {
      expect([...moveTo(index).heldTabIds]).toEqual(['row-1', 'row-2'])
    }
    expect([...moveTo(7).heldTabIds]).toEqual([])
  })

  it('carries a settled verdict across a reconnect', () => {
    // A local row the host never knew about cannot become host-owned on reconnect.
    const holdByWorktreeId = new Map<string, RestoredSpawnHoldEntry>()
    plan({ holdByWorktreeId, evidence: ANSWERED })
    const afterReconnect = plan({
      holdByWorktreeId,
      evidence: { connectionGeneration: NEXT_GENERATION, hostAnswered: false },
      isColdActivationPass: false,
      nowMs: 1_000_000
    })
    expect([...afterReconnect.heldTabIds]).toEqual(['row-1', 'row-2'])
  })
})

describe('readRestoredSpawnHoldEvidence', () => {
  afterEach(() => resetHostSessionMirrorHydrationForTests())

  it('reads the host answer from the shared mirror-hydration latch', () => {
    expect(readRestoredSpawnHoldEvidence(ENVIRONMENT_ID, WORKTREE_ID).hostAnswered).toBe(false)
    markHostSessionMirrorWorktreeHydrated(ENVIRONMENT_ID, WORKTREE_ID)
    expect(readRestoredSpawnHoldEvidence(ENVIRONMENT_ID, WORKTREE_ID).hostAnswered).toBe(true)
    // A frame for a sibling workspace is no answer for this one.
    expect(readRestoredSpawnHoldEvidence(ENVIRONMENT_ID, 'wt-other').hostAnswered).toBe(false)
  })
})

describe('applyRestoredTerminalSpawnHold', () => {
  it('removes held rows from the allowed set and lists them as deferred', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(['row-2']), releasedTabIds: new Set() }
    })
    expect([...(restrictions.get(WORKTREE_ID) ?? [])]).toEqual(['row-1'])
    expect([...(deferredMountTabIdsByWorktree.get(WORKTREE_ID) ?? [])]).toEqual(['row-2'])
  })

  it('puts released rows back and drops the restriction once nothing is deferred', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([[WORKTREE_ID, new Set(['row-1'])]])
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>([
      [WORKTREE_ID, new Set(['row-2'])]
    ])
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(), releasedTabIds: new Set(['row-2']) }
    })
    expect(restrictions.has(WORKTREE_ID)).toBe(false)
    expect(deferredMountTabIdsByWorktree.has(WORKTREE_ID)).toBe(false)
  })

  it('keeps both set identities while the held membership is unchanged', () => {
    // A settled hold re-runs every render; a fresh Set is a new prop identity downstream.
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    const apply = (heldTabIds: readonly string[]): void =>
      applyRestoredTerminalSpawnHold({
        restrictions,
        deferredMountTabIdsByWorktree,
        worktreeId: WORKTREE_ID,
        allTabIds: ['row-1', 'row-2', 'row-3'],
        plan: { heldTabIds: new Set(heldTabIds), releasedTabIds: new Set() }
      })
    apply(['row-2', 'row-3'])
    const allowed = restrictions.get(WORKTREE_ID)
    const deferred = deferredMountTabIdsByWorktree.get(WORKTREE_ID)
    // Same membership, a different plan object: exactly what a re-render produces.
    apply(['row-3', 'row-2'])
    expect(restrictions.get(WORKTREE_ID)).toBe(allowed)
    expect(deferredMountTabIdsByWorktree.get(WORKTREE_ID)).toBe(deferred)
  })

  it('replaces both sets when the held membership changes', () => {
    const restrictions = new Map<string, ReadonlySet<string>>()
    const deferredMountTabIdsByWorktree = new Map<string, ReadonlySet<string>>()
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2', 'row-3'],
      plan: { heldTabIds: new Set(['row-2', 'row-3']), releasedTabIds: new Set() }
    })
    const allowed = restrictions.get(WORKTREE_ID)
    const deferred = deferredMountTabIdsByWorktree.get(WORKTREE_ID)
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree,
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2', 'row-3'],
      plan: { heldTabIds: new Set(['row-3']), releasedTabIds: new Set(['row-2']) }
    })
    expect(restrictions.get(WORKTREE_ID)).not.toBe(allowed)
    expect(deferredMountTabIdsByWorktree.get(WORKTREE_ID)).not.toBe(deferred)
    expect([...(restrictions.get(WORKTREE_ID) ?? [])]).toEqual(['row-1', 'row-2'])
    expect([...(deferredMountTabIdsByWorktree.get(WORKTREE_ID) ?? [])]).toEqual(['row-3'])
  })

  it('leaves an unrelated restriction untouched when nothing is held or released', () => {
    const restrictions = new Map<string, ReadonlySet<string>>([[WORKTREE_ID, new Set(['row-1'])]])
    applyRestoredTerminalSpawnHold({
      restrictions,
      deferredMountTabIdsByWorktree: new Map(),
      worktreeId: WORKTREE_ID,
      allTabIds: ['row-1', 'row-2'],
      plan: { heldTabIds: new Set(), releasedTabIds: new Set() }
    })
    expect([...(restrictions.get(WORKTREE_ID) ?? [])]).toEqual(['row-1'])
  })
})
