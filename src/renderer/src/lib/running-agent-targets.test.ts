import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry, AgentStatusState } from '../../../shared/agent-status-types'
import type { TerminalTab } from '../../../shared/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget
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
    Pick<AppState, 'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId'>
  > = {}
) {
  return {
    agentStatusByPaneKey: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [tab(TAB_ID)],
      [OTHER_WORKTREE_ID]: [tab(OTHER_TAB_ID, OTHER_WORKTREE_ID)]
    },
    terminalLayoutsByTabId: {},
    ...overrides
  } as Pick<AppState, 'agentStatusByPaneKey' | 'tabsByWorktree' | 'terminalLayoutsByTabId'>
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

  it('allows fresh waiting and blocked agent states when the pane has a leaf PTY', () => {
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
      status: 'disabled',
      disabledReason: 'Agent is working',
      ptyId: 'pty-left'
    })
    expect(targets.find((target) => target.paneKey === waitingPaneKey)).toMatchObject({
      status: 'eligible',
      ptyId: 'pty-right'
    })
    expect(targets.find((target) => target.paneKey === blockedPaneKey)).toMatchObject({
      status: 'eligible',
      ptyId: 'pty-other'
    })
  })

  it('disables stale agent status rows even when the pane still has a leaf PTY', () => {
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
        }
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
      status: 'eligible',
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
})
