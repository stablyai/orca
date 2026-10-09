/**
 * A live renderer publisher can return to a worktree after a temporary headless publisher owned it,
 * and the epoch it returns under is already in `retired`. The fence rejects that frame — correctly,
 * because it cannot tell it apart from a delayed frame queued by a dead generation — so the drop
 * has to be repaired from authority instead of being final.
 *
 * Sequence: renderer R → temporary headless H → current renderer R again. New tabs and removals
 * apply after an authoritative confirmation; delayed H frames stay rejected.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot
} from './web-session-tabs-sync'
import {
  recordReceivedWebSessionTabsSnapshot,
  sessionTabsFreshnessKey,
  shouldApplyRecoveredWebSessionTabsSnapshot
} from './web-session-tabs-sync/tracking'
import { isRetiredSessionTabsPublicationEpoch } from './web-session-tabs-sync/publisher-identity-fences'
import { sessionTabsPublicationEpochHistoryByWorktree } from './web-session-tabs-sync/state'
import {
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync'

vi.mock('../store', () => ({ useAppStore: { setState: vi.fn() } }))
vi.mock('@/hooks/agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn()
}))

const ENV = 'remote-runtime'
const WORKTREE = 'repo::/worktree'
const RENDERER_EPOCH = 'renderer:R:client-navigation'
const HEADLESS_EPOCH = 'headless:H:client-navigation'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
})

function terminalTab(
  leafId: string,
  title: string,
  terminal: string
): RuntimeMobileSessionTabsResult['tabs'][number] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the helper constructs a complete terminal-tab union member.
  return {
    type: 'terminal',
    id: `host-tab::${leafId}`,
    parentTabId: `host-tab::${leafId}`,
    leafId,
    title,
    isActive: true,
    status: 'ready',
    terminal
  } as RuntimeMobileSessionTabsResult['tabs'][number]
}

function frame(
  publicationEpoch: string,
  snapshotVersion: number,
  tabs: RuntimeMobileSessionTabsResult['tabs']
): RuntimeMobileSessionTabsResult {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal names every field this suite reads.
  return {
    worktree: WORKTREE,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: tabs.length > 0 ? 'terminal' : null,
    tabs
  } as RuntimeMobileSessionTabsResult
}

function terminalTitles(state: WebSessionTabsSyncState): string[] {
  return (state.tabsByWorktree[WORKTREE] ?? []).map((tab) => tab.title)
}

/** Everything up to and including the drop of returning R. */
function replayUntilDrop(): {
  receivedFrame: number
  snapshot: RuntimeMobileSessionTabsResult
} {
  const withAgent = frame(RENDERER_EPOCH, 180, [terminalTab(LEAF_A, 'Agent', 'term_a')])
  recordReceivedWebSessionTabsSnapshot(ENV, withAgent)
  expect(decideWebSessionTabsSnapshot(withAgent, ENV).apply).toBe(true)

  const headless = frame(HEADLESS_EPOCH, 181, [terminalTab(LEAF_A, 'Agent', 'term_a')])
  recordReceivedWebSessionTabsSnapshot(ENV, headless)
  expect(decideWebSessionTabsSnapshot(headless, ENV).apply).toBe(true)

  const returning = frame(RENDERER_EPOCH, 187, [
    terminalTab(LEAF_A, 'Agent', 'term_a'),
    terminalTab(LEAF_B, 'Terminal', 'term_b')
  ])
  const receivedFrame = recordReceivedWebSessionTabsSnapshot(ENV, returning)
  return { receivedFrame, snapshot: returning }
}

describe('retired-epoch repair for a returning remote renderer publisher', () => {
  it('POSITIVE CONTROL: the same frame lands when no epoch has been retired', () => {
    const snapshot = frame(RENDERER_EPOCH, 187, [
      terminalTab(LEAF_A, 'Agent', 'term_a'),
      terminalTab(LEAF_B, 'Terminal', 'term_b')
    ])
    expect(decideWebSessionTabsSnapshot(snapshot, ENV).apply).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot helper returns a partial store patch by contract.
    const patch = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV) as Partial<WebSessionTabsSyncState>
    expect((patch.tabsByWorktree?.[WORKTREE] ?? []).map((tab) => tab.title)).toEqual(
      expect.arrayContaining(['Agent', 'Terminal'])
    )
  })

  it('drops the returning publisher at both recovery and decide gates', () => {
    const { receivedFrame, snapshot } = replayUntilDrop()

    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, receivedFrame)).toBe(false)
    expect(decideWebSessionTabsSnapshot(snapshot, ENV).apply).toBe(false)
    expect(
      isRetiredSessionTabsPublicationEpoch(sessionTabsFreshnessKey(ENV, WORKTREE), RENDERER_EPOCH)
    ).toBe(true)
  })

  it('lands new tabs when the authoritative census re-delivers the same frame', () => {
    const { receivedFrame, snapshot } = replayUntilDrop()
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, receivedFrame)).toBe(false)

    const authReceived = recordReceivedWebSessionTabsSnapshot(
      ENV,
      snapshot,
      undefined,
      undefined,
      'bootstrap',
      { authoritative: true }
    )
    expect(
      shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, authReceived, undefined, {
        authoritative: true
      })
    ).toBe(true)
    expect(decideWebSessionTabsSnapshot(snapshot, ENV, undefined, { authoritative: true }).apply).toBe(
      true
    )

    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot helper returns a partial store patch by contract.
    const patch = applyWebSessionTabsSnapshot(makeState(), snapshot, ENV) as Partial<WebSessionTabsSyncState>
    expect((patch.tabsByWorktree?.[WORKTREE] ?? []).map((tab) => tab.title)).toEqual(
      expect.arrayContaining(['Agent', 'Terminal'])
    )
  })

  it('applies tab removals from the revived publisher after authoritative confirmation', () => {
    const { snapshot: returning } = replayUntilDrop()
    recordReceivedWebSessionTabsSnapshot(ENV, returning, undefined, undefined, 'bootstrap', {
      authoritative: true
    })
    expect(
      decideWebSessionTabsSnapshot(returning, ENV, undefined, { authoritative: true }).apply
    ).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness state plus the tested patch forms a complete sync state.
    let state = {
      ...makeState(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot helper returns a partial store patch by contract.
      ...(applyWebSessionTabsSnapshot(makeState(), returning, ENV) as Partial<WebSessionTabsSyncState>)
    } as WebSessionTabsSyncState
    expect(terminalTitles(state)).toEqual(expect.arrayContaining(['Agent', 'Terminal']))

    const removed = frame(RENDERER_EPOCH, 188, [terminalTab(LEAF_A, 'Agent', 'term_a')])
    expect(decideWebSessionTabsSnapshot(removed, ENV).apply).toBe(true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the harness state plus the tested patch forms a complete sync state.
    state = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the snapshot helper returns a partial store patch by contract.
      ...(applyWebSessionTabsSnapshot(state, removed, ENV) as Partial<WebSessionTabsSyncState>)
    } as WebSessionTabsSyncState
    expect(terminalTitles(state)).toEqual(['Agent'])
  })

  it('a non-authoritative redelivery stays dropped, so only authority repairs it', () => {
    const { receivedFrame, snapshot } = replayUntilDrop()

    const redelivered = recordReceivedWebSessionTabsSnapshot(ENV, snapshot)
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, redelivered)).toBe(false)
    expect(decideWebSessionTabsSnapshot(snapshot, ENV).apply).toBe(false)
    // Original drop frame is still not recoverable without authority.
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, snapshot, receivedFrame)).toBe(false)
  })

  it('revives only the epoch authority names, leaving other generations fenced', () => {
    const { snapshot } = replayUntilDrop()
    recordReceivedWebSessionTabsSnapshot(ENV, snapshot, undefined, undefined, 'bootstrap', {
      authoritative: true
    })
    expect(
      decideWebSessionTabsSnapshot(snapshot, ENV, undefined, { authoritative: true }).apply
    ).toBe(true)

    const key = sessionTabsFreshnessKey(ENV, WORKTREE)
    const history = sessionTabsPublicationEpochHistoryByWorktree.get(key)
    expect(history?.current).toBe(RENDERER_EPOCH)
    expect(history?.retired).toContain(HEADLESS_EPOCH)
    expect(
      isRetiredSessionTabsPublicationEpoch(key, RENDERER_EPOCH)
    ).toBe(false)

    const delayedHeadless = frame(HEADLESS_EPOCH, 200, [
      terminalTab(LEAF_A, 'Agent', 'term_a'),
      terminalTab(LEAF_B, 'Stale', 'term_stale')
    ])
    const delayedReceived = recordReceivedWebSessionTabsSnapshot(ENV, delayedHeadless)
    expect(shouldApplyRecoveredWebSessionTabsSnapshot(ENV, delayedHeadless, delayedReceived)).toBe(
      false
    )
    expect(decideWebSessionTabsSnapshot(delayedHeadless, ENV).apply).toBe(false)
  })
})
