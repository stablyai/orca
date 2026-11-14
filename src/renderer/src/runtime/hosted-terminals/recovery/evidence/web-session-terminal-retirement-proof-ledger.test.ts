import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'

import {
  ENVIRONMENT_ID,
  makeSnapshot,
  makeState
} from '../testing/web-session-terminal-orphan-recovery-regression-fixtures'

import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from '../web-session-terminal-orphan-recovery'
import './web-session-terminal-retirement-proof-ledger'

const TAB_ID = 'host-tab'
const LEAF_ID = 'leaf-1'
const HANDLE = 'term-retired'
const WORKTREE = 'repo::ledger'
const retired = {
  parentTabId: TAB_ID,
  leafId: LEAF_ID,
  ptyId: 'pty-retired',
  terminal: HANDLE,
  incarnationId: 'inc-retired'
}

function frame(
  snapshotVersion: number,
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return { ...makeSnapshot(WORKTREE, 'epoch', []), snapshotVersion, ...overrides }
}

// Earlier proofs must retire panes on later delta frames without another host round-trip.
describe('orphan recovery over delta frames', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('retires a stale local pane from a proof delivered on an earlier frame', async () => {
    const state = makeState(WORKTREE, [{ leafId: LEAF_ID, handle: HANDLE }])
    const call = vi.fn()
    const first = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frame(1, { retiredTerminalSurfaces: [retired] }),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    expect(first?.tabs).toEqual([])

    const second = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      frame(2, { retiredTerminalSurfaces: [] }),
      ENVIRONMENT_ID,
      { call: call as never }
    )
    expect(second?.tabs).toEqual([])
    expect(second?.retiredTerminalSurfaces).toEqual([
      {
        parentTabId: 'host-tab',
        leafId: 'leaf-1',
        ptyId: 'pty-retired',
        terminal: 'term-retired',
        incarnationId: 'inc-retired'
      }
    ])
  })
})
