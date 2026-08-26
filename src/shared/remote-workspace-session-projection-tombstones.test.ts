import { describe, expect, it } from 'vitest'
import {
  exportRemoteWorkspaceSession,
  importRemoteWorkspaceSession
} from './remote-workspace-session-projection'
import { getDefaultWorkspaceSession } from './constants'

const NOW = 1_800_000_000_000
// worktreeId ↔ worktreePath 규약은 splitWorktreeId를 따른다. 기존 projection
// 테스트의 worktreeId 픽스처를 재사용해 유효한 id/path 쌍을 만든다.
const WT_ID = 'repo-a::/srv/app'
const WT_PATH = '/srv/app'
const OTHER_WT_ID = 'repo-local::/tmp/local'

describe('remote projection of closed tab tombstones', () => {
  it('export carries tombstones for target worktrees as worktreePath entries', () => {
    const session = {
      ...getDefaultWorkspaceSession(),
      closedTerminalTabTombstonesByTabId: {
        'tab-1': { closedAt: NOW, worktreeId: WT_ID },
        'tab-2': { closedAt: NOW, worktreeId: OTHER_WT_ID }
      }
    }
    const remote = exportRemoteWorkspaceSession(session, {
      isTargetWorktree: (id) => id === WT_ID
    })
    expect(remote.closedTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: NOW, worktreePath: WT_PATH }
    })
  })

  it('import resolves tombstones back to worktree ids and drops unresolvable ones', () => {
    const local = importRemoteWorkspaceSession(
      {
        activeWorktreePath: null,
        activeTabId: null,
        tabsByWorktreePath: {},
        terminalLayoutsByTabId: {},
        closedTabTombstonesByTabId: {
          'tab-1': { closedAt: NOW, worktreePath: WT_PATH },
          'tab-9': { closedAt: NOW, worktreePath: '/nowhere' }
        }
      },
      { resolveWorktreeId: (p) => (p === WT_PATH ? WT_ID : null) }
    )
    expect(local.closedTerminalTabTombstonesByTabId).toEqual({
      'tab-1': { closedAt: NOW, worktreeId: WT_ID }
    })
  })
})
