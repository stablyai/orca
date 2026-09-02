import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  ENVIRONMENT_ID,
  listResult,
  makeSnapshot,
  makeState,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  makeState as makeTabsSyncState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const TAB_ID = 'host-tab'
const LEAF_ID = 'leaf-1'
const HANDLE = 'term-live'
const PTY_ID = 'pty-live'

function listedTerminal(orphaned: boolean): Record<string, unknown> {
  return {
    handle: HANDLE,
    ptyId: PTY_ID,
    incarnationId: 'inc-live',
    orphaned
  }
}

describe('web session terminal orphan inventory retries', () => {
  beforeEach(() => {
    clearWebSessionTerminalOrphanRecoveryForTests()
    resetWebSessionTabsSyncTestState()
  })

  it.each([
    {
      name: 'a pending PTY is temporarily absent',
      incoming: 'pending' as const,
      firstInventory: []
    },
    {
      name: 'a missing surface is temporarily absent',
      incoming: 'absent' as const,
      firstInventory: []
    },
    {
      name: 'the PTY is temporarily still attached to the old graph',
      incoming: 'pending' as const,
      firstInventory: [listedTerminal(false)]
    }
  ])('retries an unchanged snapshot when $name', async ({ incoming, firstInventory }) => {
    const worktree = `repo::inventory-retry-${incoming}-${firstInventory.length}`
    const leaves = [{ leafId: LEAF_ID, handle: HANDLE }]
    const recoveryState = makeState(worktree, leaves)
    const state: WebSessionTabsSyncState = makeTabsSyncState({
      activeWorktreeId: worktree,
      tabsByWorktree: recoveryState.tabsByWorktree,
      terminalLayoutsByTabId: recoveryState.terminalLayoutsByTabId,
      activeTabIdByWorktree: {
        [worktree]: recoveryState.activeTabIdByWorktree[worktree] ?? null
      },
      activeGroupIdByWorktree: {},
      ptyIdsByTabId: Object.fromEntries(
        Object.entries(recoveryState.terminalLayoutsByTabId).map(([tabId, layout]) => [
          tabId,
          Object.values(layout.ptyIdsByLeafId ?? {})
        ])
      )
    })
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'unchanged-inventory', leaves),
      tabs: incoming === 'pending' ? [pendingSurface(TAB_ID, LEAF_ID, PTY_ID)] : []
    }
    const adoptedSnapshot: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'adopted',
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs: [pendingSurface(TAB_ID, LEAF_ID, PTY_ID, HANDLE)]
    }
    let listAttempts = 0
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        listAttempts += 1
        return {
          ok: true as const,
          result: listResult(worktree, listAttempts === 1 ? firstInventory : [listedTerminal(true)])
        }
      }
      return {
        ok: true as const,
        result: { adopted: true, topologyRevision: 8, snapshot: adoptedSnapshot }
      }
    })

    const first = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const firstPatch = applyWebSessionTabsSnapshot(state, first!, ENVIRONMENT_ID)
    const appliedState = firstPatch === state ? state : { ...state, ...firstPatch }
    const localTabId = recoveryState.tabsByWorktree[worktree]![0]!.id
    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      appliedState,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(first?.tabs).toEqual([
      expect.objectContaining({ leafId: LEAF_ID, status: 'ready', terminal: HANDLE })
    ])
    expect(appliedState.ptyIdsByTabId[localTabId]).toEqual(state.ptyIdsByTabId[localTabId])
    expect(appliedState.terminalLayoutsByTabId[localTabId]?.ptyIdsByLeafId).toEqual(
      state.terminalLayoutsByTabId[localTabId]?.ptyIdsByLeafId
    )
    expect(recovered).toEqual(adoptedSnapshot)
    expect(listAttempts).toBe(2)
    expect(call.mock.calls.map(([request]) => request.method)).toEqual([
      'terminal.list',
      'terminal.list',
      'terminal.adoptOrphans'
    ])
  })

  it('requires two consecutive authoritative absences after a ready frame', async () => {
    const worktree = 'repo::inventory-ready-reset'
    const leaves = [{ leafId: LEAF_ID, handle: HANDLE }]
    const state = makeState(worktree, leaves)
    const missingSnapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'stable-publication', leaves),
      tabs: []
    }
    const readySnapshot: RuntimeMobileSessionTabsResult = {
      ...missingSnapshot,
      tabs: [pendingSurface(TAB_ID, LEAF_ID, PTY_ID, HANDLE)]
    }
    const call = vi.fn(async () => ({
      ok: true as const,
      result: listResult(worktree, [])
    }))

    const firstMiss = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      missingSnapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const observedReady = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      readySnapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const missAfterReady = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      missingSnapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )
    const confirmedMiss = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      missingSnapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(firstMiss?.tabs).toEqual([
      expect.objectContaining({ leafId: LEAF_ID, status: 'ready', terminal: HANDLE })
    ])
    expect(observedReady).toEqual(readySnapshot)
    expect(missAfterReady?.tabs).toEqual([
      expect.objectContaining({ leafId: LEAF_ID, status: 'ready', terminal: HANDLE })
    ])
    expect(confirmedMiss?.tabs).toEqual([])
    expect(call).toHaveBeenCalledTimes(3)
  })

  it('removes a missing surface immediately after an exact host retirement proof', async () => {
    const worktree = 'repo::explicit-retirement'
    const leaves = [{ leafId: LEAF_ID, handle: HANDLE }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'retired-surface', leaves),
      retiredTerminalSurfaces: [
        {
          parentTabId: TAB_ID,
          leafId: LEAF_ID,
          ptyId: PTY_ID,
          terminal: HANDLE,
          incarnationId: 'inc-live'
        }
      ],
      tabs: []
    }
    const call = vi.fn()

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered).toBe(snapshot)
    expect(recovered?.tabs).toEqual([])
    expect(call).not.toHaveBeenCalled()
  })

  it('does not apply an old retirement proof to a pending replacement surface', async () => {
    const worktree = 'repo::pending-replacement'
    const leaves = [{ leafId: LEAF_ID, handle: HANDLE }]
    const state = makeState(worktree, leaves)
    const snapshot: RuntimeMobileSessionTabsResult = {
      ...makeSnapshot(worktree, 'pending-replacement', leaves),
      retiredTerminalSurfaces: [
        {
          parentTabId: TAB_ID,
          leafId: LEAF_ID,
          ptyId: 'pty-retired',
          terminal: HANDLE,
          incarnationId: 'inc-retired'
        }
      ],
      tabs: [pendingSurface(TAB_ID, LEAF_ID, PTY_ID)]
    }
    const call = vi.fn(async () => ({
      ok: true as const,
      result: listResult(worktree, [])
    }))

    const recovered = await recoverWebSessionTerminalOrphansBeforeApply(
      state,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never }
    )

    expect(recovered?.tabs).toEqual([
      expect.objectContaining({ leafId: LEAF_ID, status: 'ready', terminal: HANDLE })
    ])
    expect(call).toHaveBeenCalledOnce()
  })
})
