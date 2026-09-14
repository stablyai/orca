import { describe, expect, it } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import type { TerminalTab, TerminalTabRecoveryLedger } from '../../../../shared/terminal-tab-types'
import { buildMirroredTerminalTabs } from './terminal-build'
import { toWebTerminalSurfaceTabId } from '../web-terminal-surface-id'

/**
 * The recovery ledger is client-local. The host publishes no such field, so a
 * rebuild that does not carry the existing one restores this tab's remount
 * allowance on EVERY snapshot — which is the remount storm (b5cfc6ca) the
 * ledger exists to end, re-armed on the host's publication cadence.
 *
 * `generation` is deliberately not asserted here: the host carries none and the
 * rebuild emits none, which is why `isSupersededLedger` compares strictly
 * forward (`>`) rather than `!==`. See terminal-tab-recovery-ledger.ts.
 */
const WORKTREE = 'repo-1::worktree-1'
const ENVIRONMENT = 'env-1'
const HOST_TAB = 'host-tab-1'

const LEDGER: TerminalTabRecoveryLedger = {
  attemptedAt: [1_000],
  generation: 1,
  outcome: 'failed',
  startedAt: 1_000,
  reason: 'reattach-unverifiable',
  tabGeneration: 1
}

function snapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'terminal',
        id: 'surface-1',
        parentTabId: HOST_TAB,
        leafId: 'leaf-1',
        title: 'Terminal',
        status: 'ready',
        terminal: 'handle-1',
        isActive: true
      }
    ]
  } as RuntimeMobileSessionTabsResult
}

function rebuild(existing?: Partial<TerminalTab>): TerminalTab {
  const localTabId = toWebTerminalSurfaceTabId(HOST_TAB)
  const existingById = new Map<string, TerminalTab>(
    existing ? [[localTabId, { id: localTabId, ...existing } as TerminalTab]] : []
  )
  const [mirrored] = buildMirroredTerminalTabs(snapshot(), ENVIRONMENT, existingById, {}, 0, 1_000)
  return mirrored!.tab
}

describe('buildMirroredTerminalTabs recovery ledger', () => {
  it('carries the client-local ledger across a host snapshot rebuild', () => {
    expect(rebuild({ recovery: LEDGER }).recovery).toEqual(LEDGER)
  })

  it('emits none for a tab that never recovered', () => {
    expect(rebuild({}).recovery).toBeUndefined()
  })

  it('emits none for a tab the client has never seen', () => {
    expect(rebuild().recovery).toBeUndefined()
  })
})
