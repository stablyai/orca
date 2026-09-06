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

  it('discards an adoption result after the local tab binding changes in flight', async () => {
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
      return adoption.promise
    })

    const recovery = recoverWebSessionTerminalOrphansBeforeApply(
      stateBeforeBindingChange,
      snapshot,
      ENVIRONMENT_ID,
      { call: call as never, getCurrentState: () => currentState }
    )
    await vi.waitFor(() =>
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ method: 'terminal.adoptOrphans' })
      )
    )
    currentState = stateAfterBindingChange
    adoption.resolve({
      ok: true,
      result: {
        adopted: true,
        topologyRevision: 8,
        snapshot: {
          ...snapshot,
          publicationEpoch: 'adopted-after-binding-change',
          tabs: [pendingSurface('host-tab', 'leaf-1', 'pty-live', 'term-live')]
        }
      }
    })

    await expect(recovery).resolves.toBeNull()
  })
})
