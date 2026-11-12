import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred } from './testing/web-session-terminal-orphan-recovery-regression-fixtures'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  clearWebSessionTerminalOrphanRecoveryForTests,
  recoverWebSessionTerminalOrphansBeforeApply
} from './web-session-terminal-orphan-recovery'

describe('web session terminal orphan recovery', () => {
  beforeEach(() => clearWebSessionTerminalOrphanRecoveryForTests())

  it('serializes a newer convergence snapshot after an in-flight adoption conflict', async () => {
    const worktree = 'repo::/worktree'
    const adoptionEntered = deferred<void>()
    let rejectFirstAdoption: (() => void) | null = null
    const call = vi.fn(async ({ method }) => {
      if (method === 'terminal.list') {
        return {
          ok: true as const,
          result: {
            terminals: [
              {
                handle: 'term_live',
                ptyId: 'pty-live',
                incarnationId: 'inc-live',
                orphaned: true
              }
            ],
            topologyRevisions: { [worktree]: 1 },
            totalCount: 1,
            truncated: false
          }
        }
      }
      return await new Promise((resolve) => {
        rejectFirstAdoption = () =>
          resolve({ ok: false as const, error: { code: 'conflict', message: 'closed' } })
        adoptionEntered.resolve()
      })
    })
    const state = {
      tabsByWorktree: {
        [worktree]: [{ id: 'web-terminal-host-tab', worktreeId: worktree } as never]
      },
      terminalLayoutsByTabId: {
        'web-terminal-host-tab': {
          root: { type: 'leaf' as const, leafId: 'leaf-1' },
          activeLeafId: 'leaf-1',
          expandedLeafId: null,
          ptyIdsByLeafId: {
            'leaf-1': toRemoteRuntimePtyId('term_live', 'windows-2')
          }
        }
      },
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {}
    }
    const missing = {
      worktree,
      publicationEpoch: 'missing',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    const converged = {
      ...missing,
      publicationEpoch: 'closed',
      snapshotVersion: 2,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab::leaf-1',
          parentTabId: 'host-tab',
          leafId: 'leaf-1',
          title: 'closed',
          isActive: false,
          status: 'ready' as const,
          terminal: 'term_live'
        }
      ]
    }

    const first = recoverWebSessionTerminalOrphansBeforeApply(state, missing, 'windows-2', {
      call: call as never
    })
    await adoptionEntered.promise
    const second = recoverWebSessionTerminalOrphansBeforeApply(state, converged, 'windows-2', {
      call: call as never
    })
    rejectFirstAdoption!()

    await expect(first).resolves.toBeNull()
    await expect(second).resolves.toMatchObject({
      publicationEpoch: 'closed',
      snapshotVersion: 2,
      tabs: [{ id: 'host-tab::leaf-1', status: 'ready', terminal: 'term_live' }]
    })
  })
})
