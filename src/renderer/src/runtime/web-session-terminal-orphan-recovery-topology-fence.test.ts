import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  ENVIRONMENT_ID,
  deferred,
  listResult,
  makeSnapshot,
  makeState,
  pendingSurface
} from './__fixtures__/web-session-terminal-orphan-recovery-regression-fixtures'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'
import { toRemoteRuntimePtyId } from './runtime-terminal-stream'

describe('web session terminal orphan recovery topology fence', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it.each(['terminal.adoptOrphans', 'session.tabs.list'])(
    'discards recovery when the local tab binding changes during %s',
    async (blockedMethod) => {
      const worktree = 'repo::tab-binding-change'
      const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
      const stateBeforeBindingChange = makeState(worktree, leaves)
      const localTab = stateBeforeBindingChange.tabsByWorktree[worktree]![0]!
      const stateAfterBindingChange = {
        ...stateBeforeBindingChange,
        tabsByWorktree: {
          ...stateBeforeBindingChange.tabsByWorktree,
          [worktree]: [
            { ...localTab, ptyId: toRemoteRuntimePtyId('term-replacement', ENVIRONMENT_ID) }
          ]
        }
      }
      let currentState = stateBeforeBindingChange
      const snapshot: RuntimeMobileSessionTabsResult = {
        ...makeSnapshot(worktree, 'tab-binding-change', leaves),
        tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live')]
      }
      const adoptedSnapshot: RuntimeMobileSessionTabsResult = {
        ...snapshot,
        publicationEpoch: 'adopted-after-binding-change',
        tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live')]
      }
      const adoption = deferred<unknown>()
      const call = vi.fn(async ({ method }: { method: string }) => {
        if (method === 'terminal.list') {
          return {
            ok: true as const,
            result: listResult(worktree, [
              {
                handle: 'term-live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ])
          }
        }
        if (method === blockedMethod) {
          return adoption.promise
        }
        return {
          ok: true,
          result: { adopted: true, topologyRevision: 8, snapshot: adoptedSnapshot }
        }
      })

      const recovery = recoverWebSessionTerminalOrphansBeforeApply(
        stateBeforeBindingChange,
        snapshot,
        ENVIRONMENT_ID,
        { call: call as never, getCurrentState: () => currentState }
      )
      await vi.waitFor(() =>
        expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: blockedMethod }))
      )
      currentState = stateAfterBindingChange
      adoption.resolve({
        ok: true,
        result:
          blockedMethod === 'session.tabs.list'
            ? adoptedSnapshot
            : { adopted: true, topologyRevision: 8, snapshot: adoptedSnapshot }
      })

      await expect(recovery).resolves.toBeNull()
    }
  )

  it('lets a newer ready frame supersede a blocked post-adoption list', async () => {
    const worktree = 'folder:newer-ready-frame'
    const leaves = [{ leafId: 'leaf-1', handle: 'term-live' }]
    const state = makeState(worktree, leaves)
    const snapshot = makeSnapshot(worktree, 'renderer:host:client-navigation', leaves)
    const adopted: RuntimeMobileSessionTabsResult = {
      ...snapshot,
      publicationEpoch: 'renderer:host',
      snapshotVersion: 2,
      tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live')]
    }
    const ready = { ...adopted, publicationEpoch: snapshot.publicationEpoch, snapshotVersion: 3 }
    const listed = deferred<unknown>()
    const call = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'terminal.list') {
        return {
          ok: true,
          result: listResult(worktree, [
            {
              handle: 'term-live',
              ptyId: 'pty-live',
              incarnationId: 'inc-live',
              orphaned: true
            }
          ])
        }
      }
      if (method === 'terminal.adoptOrphans') {
        return { ok: true, result: { adopted: true, topologyRevision: 8, snapshot: adopted } }
      }
      return listed.promise
    })
    const recovery = recoverWebSessionTerminalOrphansBeforeApply(state, snapshot, ENVIRONMENT_ID, {
      call: call as never
    })
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(expect.objectContaining({ method: 'session.tabs.list' }))
    )
    await expect(
      recoverWebSessionTerminalOrphansBeforeApply(state, ready, ENVIRONMENT_ID, {
        call: call as never
      })
    ).resolves.toBe(ready)
    listed.resolve({ ok: true, result: { ...ready, snapshotVersion: 2 } })
    await expect(recovery).resolves.toBeNull()
  })
})
