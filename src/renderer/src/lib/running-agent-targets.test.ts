import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { Tab } from '../../../shared/tab-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import {
  deriveRunningAgentSendTargets,
  deriveStatuslessStructuredAgentSendTargets,
  resolveRunningAgentSendTarget,
  runningAgentMessageTarget,
  type RunningAgentTargetState
} from './running-agent-targets'

const WORKTREE_ID = 'wt-1'
const OTHER_WORKTREE_ID = 'wt-2'
const TAB_ID = 'tab-1'
const OTHER_TAB_ID = 'tab-2'
const LEFT_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const RIGHT_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const NOW = 10_000

function tab(
  id: string,
  worktreeId = WORKTREE_ID,
  ptyId: string | null = 'fallback-pty'
): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function entry(
  paneKey: string,
  state: AgentStatusState = 'done',
  updatedAt = NOW
): AgentStatusEntry {
  return {
    paneKey,
    state,
    prompt: 'previous prompt',
    updatedAt,
    stateStartedAt: updatedAt,
    agentType: 'codex',
    stateHistory: []
  }
}

function state(
  overrides: Partial<
    Pick<
      AppState,
      | 'agentStatusByPaneKey'
      | 'tabsByWorktree'
      | 'unifiedTabsByWorktree'
      | 'terminalLayoutsByTabId'
      | 'ptyIdsByTabId'
      | 'runtimePaneTitlesByTabId'
    >
  > = {}
): RunningAgentTargetState {
  const terminalLayoutsByTabId = overrides.terminalLayoutsByTabId ?? {}
  return {
    agentStatusByPaneKey: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [tab(TAB_ID)],
      [OTHER_WORKTREE_ID]: [tab(OTHER_TAB_ID, OTHER_WORKTREE_ID)]
    },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId,
    ptyIdsByTabId: deriveLivePtyIdsByTabId(terminalLayoutsByTabId),
    runtimePaneTitlesByTabId: {},
    ...overrides
  }
}

function deriveLivePtyIdsByTabId(
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId']
): AppState['ptyIdsByTabId'] {
  return Object.fromEntries(
    Object.entries(terminalLayoutsByTabId).map(([tabId, layout]) => [
      tabId,
      Object.values(layout?.ptyIdsByLeafId ?? {})
    ])
  )
}

describe('running agent send targets', () => {
  it('marks fresh done agents with a leaf PTY as eligible', () => {
    const paneKey = makePaneKey(TAB_ID, LEFT_LEAF_ID)
    const targets = deriveRunningAgentSendTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'done') },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEFT_LEAF_ID },
            activeLeafId: LEFT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEFT_LEAF_ID]: 'pty-left' }
          }
        }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([{ paneKey, ptyId: 'pty-left', status: 'eligible' }])
    expect(targets[0]).not.toHaveProperty('disabledReason')
  })

  it('allows working agents and disables permission states when the pane has a leaf PTY', () => {
    const workingPaneKey = makePaneKey(TAB_ID, LEFT_LEAF_ID)
    const waitingPaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const blockedPaneKey = makePaneKey(OTHER_TAB_ID, OTHER_LEAF_ID)
    const targets = deriveRunningAgentSendTargets(
      state({
        agentStatusByPaneKey: {
          [workingPaneKey]: entry(workingPaneKey, 'working'),
          [waitingPaneKey]: entry(waitingPaneKey, 'waiting'),
          [blockedPaneKey]: entry(blockedPaneKey, 'blocked')
        },
        tabsByWorktree: {
          [WORKTREE_ID]: [tab(TAB_ID), tab(OTHER_TAB_ID, WORKTREE_ID)]
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: LEFT_LEAF_ID },
              second: { type: 'leaf', leafId: RIGHT_LEAF_ID }
            },
            activeLeafId: LEFT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [LEFT_LEAF_ID]: 'pty-left',
              [RIGHT_LEAF_ID]: 'pty-right'
            }
          },
          [OTHER_TAB_ID]: {
            root: { type: 'leaf', leafId: OTHER_LEAF_ID },
            activeLeafId: OTHER_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [OTHER_LEAF_ID]: 'pty-other' }
          }
        }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(resolveRunningAgentSendTarget(state(), WORKTREE_ID, 'missing')).toBeNull()
    expect(targets.find((target) => target.paneKey === workingPaneKey)).toMatchObject({
      status: 'eligible',
      ptyId: 'pty-left'
    })
    expect(targets.find((target) => target.paneKey === waitingPaneKey)).toMatchObject({
      status: 'disabled',
      disabledReason: 'Agent needs permission',
      ptyId: 'pty-right'
    })
    expect(targets.find((target) => target.paneKey === blockedPaneKey)).toMatchObject({
      status: 'disabled',
      disabledReason: 'Agent needs permission',
      ptyId: 'pty-other'
    })
  })

  it('disables a status-backed working row when the live pane title needs permission', () => {
    const paneKey = makePaneKey(TAB_ID, LEFT_LEAF_ID)
    const targets = deriveRunningAgentSendTargets(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'working') },
        tabsByWorktree: { [WORKTREE_ID]: [tab(TAB_ID, WORKTREE_ID, 'pty-left')] },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEFT_LEAF_ID },
            activeLeafId: LEFT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEFT_LEAF_ID]: 'pty-left' }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex - action required' } }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets).toMatchObject([
      {
        paneKey,
        status: 'disabled',
        disabledReason: 'Agent needs permission',
        ptyId: 'pty-left'
      }
    ])
  })

  it('keeps stale agent status rows disabled when no live title proves the agent is sendable', () => {
    const stalePaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [stalePaneKey]: entry(stalePaneKey, 'waiting', NOW - 31 * 60 * 1000)
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        }
      }),
      WORKTREE_ID,
      stalePaneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey: stalePaneKey,
      ptyId: 'pty-right',
      status: 'disabled',
      disabledReason: 'Agent status is stale'
    })
  })

  it('keeps stale agent status rows disabled when only a bare agent title remains', () => {
    const stalePaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [stalePaneKey]: entry(stalePaneKey, 'done', NOW - 31 * 60 * 1000)
        },
        tabsByWorktree: { [WORKTREE_ID]: [{ ...tab(TAB_ID), title: 'Codex' }] },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        }
      }),
      WORKTREE_ID,
      stalePaneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey: stalePaneKey,
      ptyId: 'pty-right',
      status: 'disabled',
      disabledReason: 'Agent status is stale'
    })
  })

  it('promotes stale agent status rows when a live pane title proves the agent is sendable', () => {
    const stalePaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [stalePaneKey]: entry(stalePaneKey, 'done', NOW - 31 * 60 * 1000)
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex ready' } }
      }),
      WORKTREE_ID,
      stalePaneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey: stalePaneKey,
      ptyId: 'pty-right',
      status: 'eligible'
    })
    expect(target).not.toHaveProperty('disabledReason')
  })

  it('does not promote a stale status row from a lone quarter-circle spinner title', () => {
    const paneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [paneKey]: entry(paneKey, 'done', NOW - 31 * 60 * 1000)
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        },
        runtimePaneTitlesByTabId: {
          [TAB_ID]: { 1: '\u25d1 Check package version in package.json' }
        }
      }),
      WORKTREE_ID,
      paneKey,
      NOW
    )

    // Why: the runtime's presence guard ignores a lone quarter-circle frame (STA-4028),
    // so a stale hook row must stay disabled rather than be re-offered (#24286).
    expect(target).toMatchObject({
      paneKey,
      ptyId: 'pty-right',
      status: 'disabled',
      disabledReason: 'Agent status is stale'
    })
  })

  it('does not promote an unconfirmed restored row from its preserved title', () => {
    const paneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [paneKey]: { ...entry(paneKey, 'working'), restoredUnconfirmed: true }
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex ready' } }
      }),
      WORKTREE_ID,
      paneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey,
      ptyId: 'pty-right',
      status: 'disabled',
      disabledReason: 'Agent status is stale'
    })
  })

  it('treats a missing tab title as absent live title evidence', () => {
    const paneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [paneKey]: entry(paneKey, 'done')
        },
        tabsByWorktree: {
          [WORKTREE_ID]: [{ ...tab(TAB_ID), title: undefined } as unknown as TerminalTab]
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        }
      }),
      WORKTREE_ID,
      paneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey,
      ptyId: 'pty-right',
      status: 'eligible'
    })
  })

  it('keeps stale agent status rows disabled when the live pane title needs permission', () => {
    const stalePaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: {
          [stalePaneKey]: entry(stalePaneKey, 'waiting', NOW - 31 * 60 * 1000)
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 1: 'Codex - action required' } }
      }),
      WORKTREE_ID,
      stalePaneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey: stalePaneKey,
      ptyId: 'pty-right',
      status: 'disabled',
      disabledReason: 'Agent needs permission'
    })
  })

  it('requires the clicked pane leaf PTY and ignores tab-level fallback PTYs', () => {
    const paneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'blocked') },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEFT_LEAF_ID },
              second: { type: 'leaf', leafId: RIGHT_LEAF_ID }
            },
            activeLeafId: LEFT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEFT_LEAF_ID]: 'pty-left' }
          }
        },
        runtimePaneTitlesByTabId: { [TAB_ID]: { 2: 'Codex - action required' } }
      }),
      WORKTREE_ID,
      paneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey,
      ptyId: null,
      status: 'disabled',
      disabledReason: 'Terminal is no longer available'
    })
  })

  it('disables a stale layout PTY after the live PTY map has been cleared', () => {
    const paneKey = makePaneKey(TAB_ID, LEFT_LEAF_ID)
    const target = resolveRunningAgentSendTarget(
      state({
        agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'done') },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: LEFT_LEAF_ID },
            activeLeafId: LEFT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEFT_LEAF_ID]: 'pty-left' }
          }
        },
        ptyIdsByTabId: { [TAB_ID]: [] }
      }),
      WORKTREE_ID,
      paneKey,
      NOW
    )

    expect(target).toMatchObject({
      paneKey,
      ptyId: null,
      status: 'disabled',
      disabledReason: 'Terminal is no longer available'
    })
  })

  it('keeps other-workspace and remote PTY targets scoped correctly', () => {
    const localPaneKey = makePaneKey(TAB_ID, LEFT_LEAF_ID)
    const remotePaneKey = makePaneKey(OTHER_TAB_ID, OTHER_LEAF_ID)
    const base = state({
      agentStatusByPaneKey: {
        [localPaneKey]: entry(localPaneKey, 'waiting'),
        [remotePaneKey]: entry(remotePaneKey, 'waiting')
      },
      terminalLayoutsByTabId: {
        [TAB_ID]: {
          root: { type: 'leaf', leafId: LEFT_LEAF_ID },
          activeLeafId: LEFT_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEFT_LEAF_ID]: 'pty-local' }
        },
        [OTHER_TAB_ID]: {
          root: { type: 'leaf', leafId: OTHER_LEAF_ID },
          activeLeafId: OTHER_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [OTHER_LEAF_ID]: 'remote:env@@terminal-1' }
        }
      }
    })

    expect(deriveRunningAgentSendTargets(base, WORKTREE_ID, NOW)).toHaveLength(1)
    expect(
      resolveRunningAgentSendTarget(base, OTHER_WORKTREE_ID, remotePaneKey, NOW)
    ).toMatchObject({
      status: 'disabled',
      disabledReason: 'Agent needs permission',
      ptyId: 'remote:env@@terminal-1'
    })
  })

  it('skips retained-only, malformed, and legacy numeric pane keys', () => {
    const missingTabPaneKey = makePaneKey('missing-tab', LEFT_LEAF_ID)
    const validPaneKey = makePaneKey(TAB_ID, RIGHT_LEAF_ID)
    const targets = deriveRunningAgentSendTargets(
      state({
        agentStatusByPaneKey: {
          [missingTabPaneKey]: entry(missingTabPaneKey, 'done'),
          'tab-1:1': entry('tab-1:1', 'done'),
          'not-a-pane-key': entry('not-a-pane-key', 'done'),
          [validPaneKey]: entry(validPaneKey, 'done')
        },
        terminalLayoutsByTabId: {
          [TAB_ID]: {
            root: { type: 'leaf', leafId: RIGHT_LEAF_ID },
            activeLeafId: RIGHT_LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [RIGHT_LEAF_ID]: 'pty-right' }
          }
        }
      }),
      WORKTREE_ID,
      NOW
    )

    expect(targets.map((target) => target.paneKey)).toEqual([validPaneKey])
  })

  describe('structured chat sessions', () => {
    const CHAT_TAB_ID = 'structured-agent-session-claude_1'
    const SESSION_ID = 'claude_1'
    const chatPaneKey = structuredAgentSessionPaneKey(CHAT_TAB_ID, SESSION_ID)

    function workspaceTab(overrides: Partial<Tab>): Tab {
      return {
        id: CHAT_TAB_ID,
        entityId: SESSION_ID,
        groupId: 'group-1',
        worktreeId: WORKTREE_ID,
        contentType: 'agent-session',
        agentSessionAgent: 'claude',
        label: 'Claude Chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1,
        ...overrides
      }
    }

    it('lists a chat with a status entry, addressed by session', () => {
      const chatEntry = entry(chatPaneKey, 'done')
      const targets = deriveRunningAgentSendTargets(
        state({
          agentStatusByPaneKey: { [chatPaneKey]: chatEntry },
          unifiedTabsByWorktree: { [WORKTREE_ID]: [workspaceTab({})] }
        }),
        WORKTREE_ID,
        NOW
      )

      expect(targets).toEqual([
        {
          kind: 'structured-session',
          paneKey: chatPaneKey,
          tabId: CHAT_TAB_ID,
          sessionId: SESSION_ID,
          agentType: 'claude',
          title: 'Claude Chat',
          entry: chatEntry,
          status: 'eligible'
        }
      ])
      expect(runningAgentMessageTarget(targets[0])).toEqual({
        kind: 'structured-session',
        sessionId: SESSION_ID
      })
    })

    it('lists a chat before its first turn only as a status-less target, which has no sidebar row', () => {
      const chatState = state({ unifiedTabsByWorktree: { [WORKTREE_ID]: [workspaceTab({})] } })

      expect(deriveRunningAgentSendTargets(chatState, WORKTREE_ID, NOW)).toEqual([])
      expect(deriveStatuslessStructuredAgentSendTargets(chatState, WORKTREE_ID)).toEqual([
        {
          kind: 'structured-session',
          paneKey: chatPaneKey,
          tabId: CHAT_TAB_ID,
          sessionId: SESSION_ID,
          agentType: 'claude',
          title: 'Claude Chat',
          entry: null,
          status: 'eligible'
        }
      ])
    })

    it('disables a chat whose agent is waiting on an approval', () => {
      const targets = deriveRunningAgentSendTargets(
        state({
          agentStatusByPaneKey: { [chatPaneKey]: entry(chatPaneKey, 'blocked') },
          unifiedTabsByWorktree: { [WORKTREE_ID]: [workspaceTab({})] }
        }),
        WORKTREE_ID,
        NOW
      )

      expect(targets).toMatchObject([
        { paneKey: chatPaneKey, status: 'disabled', disabledReason: 'Agent needs permission' }
      ])
    })

    it('skips other workspace tabs and chats in other worktrees', () => {
      const targets = deriveStatuslessStructuredAgentSendTargets(
        state({
          unifiedTabsByWorktree: {
            [WORKTREE_ID]: [
              workspaceTab({ id: TAB_ID, entityId: TAB_ID, contentType: 'terminal' }),
              workspaceTab({ id: 'notes.md', entityId: 'notes.md', contentType: 'editor' })
            ],
            [OTHER_WORKTREE_ID]: [workspaceTab({ worktreeId: OTHER_WORKTREE_ID })]
          }
        }),
        WORKTREE_ID
      )

      expect(targets).toEqual([])
    })
  })
})
