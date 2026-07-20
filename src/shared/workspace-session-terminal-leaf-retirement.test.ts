import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from './constants'
import type { WorkspaceSessionState } from './types'
import { retireTerminalLeafInWorkspaceSession } from './workspace-session-terminal-leaf-retirement'

const WORKTREE_ID = 'worktree-1'
const TAB_ID = 'terminal-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: WORKTREE_ID,
    activeTabId: TAB_ID,
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          ptyId: 'pty-b',
          worktreeId: WORKTREE_ID,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', leafId: LEAF_A },
          second: { type: 'leaf', leafId: LEAF_B }
        },
        activeLeafId: LEAF_B,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' }
      }
    },
    remoteSessionIdsByTabId: { [TAB_ID]: 'pty-b' },
    sleepingAgentSessionsByPaneKey: {
      [`${TAB_ID}:${LEAF_A}`]: {
        paneKey: `${TAB_ID}:${LEAF_A}`,
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'a' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      },
      [`${TAB_ID}:${LEAF_B}`]: {
        paneKey: `${TAB_ID}:${LEAF_B}`,
        worktreeId: WORKTREE_ID,
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'b' },
        prompt: '',
        state: 'done',
        capturedAt: 1,
        updatedAt: 1
      }
    }
  }
}

describe('retireTerminalLeafInWorkspaceSession', () => {
  it('rebinds parent metadata to the surviving leaf and removes only exited pane state', () => {
    const result = retireTerminalLeafInWorkspaceSession(session(), WORKTREE_ID, {
      parentTabId: TAB_ID,
      leafId: LEAF_B,
      expectedPtyId: 'pty-b'
    })

    expect(result).toMatchObject({ retired: true, parentRemoved: false })
    expect(result.session.tabsByWorktree[WORKTREE_ID]?.[0]?.ptyId).toBe('pty-a')
    expect(result.session.remoteSessionIdsByTabId?.[TAB_ID]).toBe('pty-a')
    expect(result.session.sleepingAgentSessionsByPaneKey).toHaveProperty(`${TAB_ID}:${LEAF_A}`)
    expect(result.session.sleepingAgentSessionsByPaneKey).not.toHaveProperty(`${TAB_ID}:${LEAF_B}`)
  })

  it('refuses a stale exit after the leaf has rebound', () => {
    const original = session()
    const result = retireTerminalLeafInWorkspaceSession(original, WORKTREE_ID, {
      parentTabId: TAB_ID,
      leafId: LEAF_B,
      expectedPtyId: 'pty-old'
    })

    expect(result).toEqual({ session: expect.any(Object), retired: false, parentRemoved: false })
    expect(result.session).toBe(original)
  })
})
