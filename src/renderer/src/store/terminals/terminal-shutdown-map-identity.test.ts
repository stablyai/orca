import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { commitTerminalShutdownState } from './terminal-shutdown-state'

const WORKTREE = 'repo::/tmp/app'
const TAB_ID = 'tab-a'

const tab = { id: TAB_ID, worktreeId: WORKTREE } as unknown as TerminalTab

/** Maps a shutdown with nothing left to clear must not re-reference. */
const UNTOUCHED_FIELDS = [
  'ptyIdsByTabId',
  'suppressedPtyExitIds',
  'pendingPtyShutdownIds',
  'pendingCodexPaneRestartIds',
  'codexRestartNoticeByPtyId',
  'pendingSetupSplitByTabId',
  'pendingIssueCommandSplitByTabId',
  'terminalLayoutsByTabId',
  'runtimePaneTitlesByTabId',
  'lastKnownRelayPtyIdByTabId'
] as const

function buildState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: { [WORKTREE]: [tab] },
    // The tab already exited: its pty list is present and empty.
    ptyIdsByTabId: { [TAB_ID]: [] },
    suppressedPtyExitIds: {},
    pendingPtyShutdownIds: {},
    pendingCodexPaneRestartIds: {},
    codexRestartNoticeByPtyId: {},
    pendingSetupSplitByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    unreadAgentCompletionPanes: {},
    lastTerminalInputAtByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    // Post-write actions this helper calls; irrelevant to the identity contract.
    dropAgentStatusByWorktree: () => undefined,
    clearPaneForegroundAgentByWorktree: () => undefined,
    clearSleepingAgentSessionsByWorktree: () => undefined,
    isPtyShutdownPending: () => false,
    ...overrides
  } as unknown as AppState
}

function commit(state: AppState, exitGuardPtyIds: readonly string[] = []): AppState {
  let current = state
  commitTerminalShutdownState({
    exitGuardPtyIds,
    get: (() => current) as never,
    keepIdentifiers: true,
    retainedCompletionEvidence: [],
    set: ((update: unknown) => {
      const patch =
        typeof update === 'function' ? (update as (s: AppState) => object)(current) : update
      current = { ...current, ...(patch as object) }
    }) as never,
    shutdownReason: 'manual-sleep',
    sleepingAgentSessionRecords: {},
    tabs: [tab],
    worktreeId: WORKTREE
  })
  return current
}

describe('terminal shutdown map identity', () => {
  it('keeps every map reference when the panes already exited', () => {
    const before = buildState()

    const after = commit(before)

    for (const field of UNTOUCHED_FIELDS) {
      expect(after[field], field).toBe(before[field])
    }
  })

  it('creates an absent pty-id entry rather than skipping it', () => {
    // An absent key is not an empty array: the spread this replaces created the key.
    const before = buildState({ ptyIdsByTabId: {} } as Partial<AppState>)

    const after = commit(before)

    expect(after.ptyIdsByTabId).not.toBe(before.ptyIdsByTabId)
    expect(TAB_ID in after.ptyIdsByTabId).toBe(true)
    expect(after.ptyIdsByTabId[TAB_ID]).toEqual([])
  })

  it('still clears a live pty list and drops the exit-guard bookkeeping', () => {
    const before = buildState({
      ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
      pendingPtyShutdownIds: { 'pty-1': 1 },
      codexRestartNoticeByPtyId: { 'pty-1': { reason: 'x' } }
    } as unknown as Partial<AppState>)

    const after = commit(before, ['pty-1'])

    expect(after.ptyIdsByTabId[TAB_ID]).toEqual([])
    expect(after.suppressedPtyExitIds['pty-1']).toBe(true)
    expect('pty-1' in after.pendingPtyShutdownIds).toBe(false)
    expect('pty-1' in after.codexRestartNoticeByPtyId).toBe(false)
  })
})
