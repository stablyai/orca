import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../constants'
import type { ExecutionHostId } from '../../execution-host'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import { TEST_LEAF_1, TEST_LEAF_2 } from '../../../main/persistence/persistence-session-fixtures'
import { findTerminalBindingConflict } from './terminal-owner-invariants'

const WT = 'repo-1::/tmp/wt'

function partition(
  hostId: ExecutionHostId,
  tabs: [string, string, string, string?][]
): { hostId: ExecutionHostId; session: WorkspaceSessionState } {
  return {
    hostId,
    session: {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [WT]: tabs.map(([id, , ptyId]) => ({
          id,
          ptyId,
          worktreeId: WT,
          title: id,
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }))
      },
      terminalLayoutsByTabId: Object.fromEntries(
        tabs.map(([id, leafId, ptyId]) => [
          id,
          {
            root: { type: 'leaf', leafId },
            activeLeafId: leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [leafId]: ptyId }
          }
        ])
      ),
      terminalPtyIncarnationsByPaneKey: Object.fromEntries(
        tabs.flatMap(([id, leafId, , incarnation]) =>
          incarnation ? [[`${id}:${leafId}`, incarnation]] : []
        )
      )
    }
  }
}

const bind = (tabId: string, leafId: string, ptyId: string, incarnationId?: string) => ({
  tabId,
  leafId,
  ptyId,
  ...(incarnationId ? { incarnationId } : {})
})

describe('findTerminalBindingConflict', () => {
  // STA-9417: startup adopted an already-bound setup PTY into a second leaf.
  it('finds a terminal another tab already binds, naming its leaf', () => {
    const conflict = findTerminalBindingConflict(
      bind('tab-b', TEST_LEAF_2, 'pty-1', 'i1'),
      'local',
      [partition('local', [['tab-a', TEST_LEAF_1, 'pty-1', 'i1']])]
    )
    expect(conflict?.reason).toBe('pty_bound_to_other_leaf')
    expect(conflict?.owner).toMatchObject({ hostId: 'local', leafId: TEST_LEAF_1, ptyId: 'pty-1' })
    expect(conflict?.owner.tab.id).toBe('tab-a')
  })

  it('finds a terminal another leaf of the same tab binds', () => {
    const session = partition('local', [['tab-a', TEST_LEAF_1, 'pty-1']])
    session.session.terminalLayoutsByTabId['tab-a'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: TEST_LEAF_1 },
        second: { type: 'leaf', leafId: TEST_LEAF_2 }
      },
      activeLeafId: TEST_LEAF_1,
      expandedLeafId: null,
      ptyIdsByLeafId: { [TEST_LEAF_1]: 'pty-1' }
    }
    expect(
      findTerminalBindingConflict(bind('tab-a', TEST_LEAF_2, 'pty-1'), 'local', [session])?.reason
    ).toBe('pty_bound_to_other_leaf')
  })

  it('keys a terminal by incarnation, so a stale incarnation elsewhere is not an owner', () => {
    expect(
      findTerminalBindingConflict(bind('tab-b', TEST_LEAF_2, 'pty-1', 'i2'), 'local', [
        partition('local', [['tab-a', TEST_LEAF_1, 'pty-1', 'i1']])
      ])
    ).toBeNull()
  })

  // STA-9259: moved leaves must not bind under both source and destination tabs.
  it('finds a leaf id another tab already holds', () => {
    const conflict = findTerminalBindingConflict(bind('tab-b', TEST_LEAF_1, 'pty-9'), 'local', [
      partition('local', [['tab-a', TEST_LEAF_1, 'pty-1']])
    ])
    expect(conflict?.reason).toBe('leaf_in_other_tab')
    expect(conflict?.owner.tab.id).toBe('tab-a')
  })

  it('checks the local and ssh partitions together', () => {
    const ptyId = 'ssh:ssh-1@@relay-1'
    const conflict = findTerminalBindingConflict(bind('tab-local', TEST_LEAF_2, ptyId), 'local', [
      partition('local', []),
      partition('ssh:ssh-1', [['tab-ssh', TEST_LEAF_1, ptyId]])
    ])
    expect(conflict?.owner).toMatchObject({ hostId: 'ssh:ssh-1', leafId: TEST_LEAF_1 })
  })

  it('treats the same tab:leaf in two partitions as one surface', () => {
    const ptyId = 'ssh:ssh-1@@relay-1'
    expect(
      findTerminalBindingConflict(bind('tab-ssh', TEST_LEAF_1, ptyId), 'local', [
        partition('local', [['tab-ssh', TEST_LEAF_1, ptyId]]),
        partition('ssh:ssh-1', [['tab-ssh', TEST_LEAF_1, ptyId]])
      ])
    ).toBeNull()
  })

  // Relay IDs repeat after restart; equality needs incarnation proof too.
  it('does not match a repeating relay id without both incarnations', () => {
    const ptyId = 'ssh:ssh-1@@pty-1'
    const saved = [partition('ssh:ssh-1', [['tab-a', TEST_LEAF_1, ptyId]])]
    expect(
      findTerminalBindingConflict(bind('tab-b', TEST_LEAF_2, ptyId, 'i2'), 'ssh:ssh-1', saved)
    ).toBeNull()
    const incarnated = [partition('ssh:ssh-1', [['tab-a', TEST_LEAF_1, ptyId, 'i1']])]
    expect(
      findTerminalBindingConflict(bind('tab-b', TEST_LEAF_2, ptyId, 'i1'), 'ssh:ssh-1', incarnated)
        ?.reason
    ).toBe('pty_bound_to_other_leaf')
  })
})
