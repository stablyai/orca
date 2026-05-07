import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAutoAckTargets } from './useAutoAckViewedAgent'
import { createTestStore, makeTab } from '../store/slices/store-test-helpers'
import type { RetainedAgentEntry } from '../store/slices/agent-status'

// Why: regression coverage for the codex inline-agent row that stayed bold
// after returning from another workspace (docs/codex-agent-row-bold-stuck.md).
// The race: codex emits `Stop` (state=done), then its TUI title reverts to a
// shell label; pty-connection.ts:onAgentExited fires removeAgentStatus before
// the live `done` row could be auto-acked. The retention sync snapshots the
// `done` row into retainedAgentsByPaneKey carrying a fresh stateStartedAt.
// Pre-fix: useAutoAckViewedAgent only walked the live map, so the retained
// row's stateStartedAt > ackAt forever. Fix: walk both maps.
//
// We test the pure helper (computeAutoAckTargets) rather than the hook so the
// vitest 'node' environment doesn't need to mock document.visibilityState,
// document.hasFocus, or the focus/visibilitychange event surface. The hook's
// gate logic is unchanged by this fix — only the scan body was extended.

describe('computeAutoAckTargets — codex retain race regression', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('acks a paneKey whose live row was retained mid-frame', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const paneKey = 'tab-codex:2'
    const activeTabId = 'tab-codex'

    // 1. Codex starts working, user acks it (e.g. by clicking the row).
    store.getState().setAgentStatus(paneKey, {
      state: 'working',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    store.getState().acknowledgeAgents([paneKey])
    const workingAck = store.getState().acknowledgedAgentsByPaneKey[paneKey]
    expect(workingAck).toBeGreaterThan(0)

    // 2. Time advances; codex Stop fires → state=done with a fresh
    //    stateStartedAt (carry-forward only applies within the same state).
    vi.setSystemTime(new Date('2026-05-05T12:00:10.000Z'))
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'sleep 10 then say hi',
      agentType: 'codex'
    })
    const liveDone = store.getState().agentStatusByPaneKey[paneKey]
    expect(liveDone.stateStartedAt).toBeGreaterThan(workingAck)

    // 3. The codex TUI title reverts to a plain shell label, so
    //    onAgentExited → removeAgentStatus tears down the live entry AND
    //    wipes the prior ack (per agent-status.ts cleanup contract).
    const retentionSnapshot: RetainedAgentEntry = {
      entry: liveDone,
      worktreeId: 'wt-1',
      tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
      agentType: 'codex',
      startedAt: liveDone.stateStartedAt
    }
    store.getState().removeAgentStatus(paneKey)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().acknowledgedAgentsByPaneKey[paneKey]).toBeUndefined()

    // 4. The retention sync picks up the live→gone transition and stashes a
    //    snapshot with the post-Stop stateStartedAt — same as
    //    collectRetainedAgentsOnDisappear in useRetainedAgents.ts.
    store.getState().retainAgents([retentionSnapshot])
    expect(store.getState().retainedAgentsByPaneKey[paneKey]).toBeDefined()

    // 5. The user is back on the codex tab. computeAutoAckTargets must see
    //    the retained row and surface it for ack — pre-fix this returned [].
    const targets = computeAutoAckTargets(store.getState(), activeTabId)
    expect(targets).toEqual([paneKey])
  })

  it('returns no targets once the retained row has been acked', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const paneKey = 'tab-codex:2'
    const activeTabId = 'tab-codex'

    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p',
      agentType: 'codex'
    })
    const doneEntry = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry: doneEntry,
        worktreeId: 'wt-1',
        tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: doneEntry.stateStartedAt
      }
    ])
    store.getState().removeAgentStatus(paneKey)

    // First scan: the retained row is unvisited.
    expect(computeAutoAckTargets(store.getState(), activeTabId)).toEqual([paneKey])

    // Simulate the ack effect.
    vi.setSystemTime(new Date('2026-05-05T12:00:01.000Z'))
    store.getState().acknowledgeAgents([paneKey])

    // Second scan: idempotent — nothing to ack.
    expect(computeAutoAckTargets(store.getState(), activeTabId)).toEqual([])
  })

  it('skips retained rows whose paneKey is on a different tab', () => {
    const store = createTestStore()
    const paneKey = 'tab-other:0'
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p',
      agentType: 'codex'
    })
    const entry = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry,
        worktreeId: 'wt-1',
        tab: makeTab({ id: 'tab-other', worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: entry.stateStartedAt
      }
    ])
    store.getState().removeAgentStatus(paneKey)

    // Active tab differs — the retained row must NOT be acked while the user
    // is looking at a different tab; the bold-until-viewed signal must
    // survive the tab switch.
    expect(computeAutoAckTargets(store.getState(), 'tab-codex')).toEqual([])
  })

  it('acks a paneKey present in BOTH live and retained without throwing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00.000Z'))
    const store = createTestStore()
    const paneKey = 'tab-codex:2'
    const activeTabId = 'tab-codex'

    // Construct a (rare) state where retainedAgentsByPaneKey and
    // agentStatusByPaneKey both contain the same paneKey — e.g. the
    // retention sync hadn't observed the new live entry yet. The merged
    // scan should report the paneKey at most twice (acknowledgeAgents
    // collapses duplicates), never throw.
    store.getState().setAgentStatus(paneKey, {
      state: 'done',
      prompt: 'p1',
      agentType: 'codex'
    })
    const liveDone = store.getState().agentStatusByPaneKey[paneKey]
    store.getState().retainAgents([
      {
        entry: liveDone,
        worktreeId: 'wt-1',
        tab: makeTab({ id: activeTabId, worktreeId: 'wt-1' }),
        agentType: 'codex',
        startedAt: liveDone.stateStartedAt
      }
    ])

    const targets = computeAutoAckTargets(store.getState(), activeTabId)
    // Two pushes, same paneKey — duplicates are intentional and harmless;
    // acknowledgeAgents short-circuits per key.
    expect(targets.length).toBeLessThanOrEqual(2)
    expect(targets.every((k) => k === paneKey)).toBe(true)
    expect(targets.includes(paneKey)).toBe(true)
  })
})
