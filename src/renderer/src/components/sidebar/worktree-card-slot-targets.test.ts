import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { expandWorkspaceUnreadTargets, workspaceUnreadTarget } from './worktree-card-slot-targets'

const WS = 'ws-scale'
const REMOTE = 'runtime:host-B' as const
const MARKER = 'agent-completion' as const

/**
 * T marked terminal tabs alternating local/remote, one structured chat whose old session also
 * left a completion, and C unrelated completion markers in other workspaces.
 */
function buildState(tabCount: number, unrelatedCount: number): AppState {
  const terminals = Array.from({ length: tabCount }, (_, i) =>
    makeTab({
      id: `t${i}`,
      worktreeId: WS,
      ptyId: i % 2 === 0 ? `remote:host-B@@pty-${i}` : `pty-${i}`
    })
  )
  const chat = makeUnifiedTab({
    id: 'chat',
    worktreeId: WS,
    groupId: 'g',
    contentType: 'agent-session',
    entityId: 'session-2',
    executionHostId: REMOTE,
    agentSessionAgent: 'claude'
  })
  const unified = [
    ...terminals.map((tab) =>
      makeUnifiedTab({
        id: `u-${tab.id}`,
        worktreeId: WS,
        groupId: 'g',
        entityId: tab.id
      })
    ),
    chat
  ]
  const completions: AppState['unreadAgentCompletionPanes'] = {}
  for (const tab of terminals) {
    completions[`${tab.id}:leaf`] = MARKER
  }
  completions[structuredAgentSessionPaneKey('chat', 'session-1')] = MARKER
  completions[structuredAgentSessionPaneKey('chat', 'session-2')] = MARKER
  for (let j = 0; j < unrelatedCount; j++) {
    completions[`other${j}:leaf`] = MARKER
  }
  return {
    ...useAppStore.getInitialState(),
    workspacesMarkedUnreadByUser: {},
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: completions,
    tabsByWorktree: { [WS]: terminals },
    unifiedTabsByWorktree: { [WS]: unified },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {}
  }
}

describe('workspace unread targets', () => {
  it('keeps host ownership and structured-session filtering', () => {
    const state = buildState(4, 3)
    const remote = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, REMOTE)])
    expect(remote.map((target) => [target.tabId, target.unreadPaneKeys])).toEqual([
      ['t0', ['t0:leaf']],
      ['t2', ['t2:leaf']],
      ['chat', ['chat:5d906140-8048-412d-a539-25aed45333a1']]
    ])
    const local = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, 'local')])
    expect(local.map((target) => [target.tabId, target.unreadPaneKeys])).toEqual([
      ['t1', ['t1:leaf']],
      ['t3', ['t3:leaf']]
    ])
  })

  it('keeps a manual mark as its own target alongside tab targets', () => {
    const state = buildState(2, 0)
    state.workspacesMarkedUnreadByUser = {
      [composeWorktreeHostIdentity('local', WS)]: true
    }
    const local = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, 'local')])
    expect(
      local.map((target) => target.tabId ?? (target.markedByUser ? 'manual' : 'workspace'))
    ).toEqual(['t1', 'manual'])
  })
})
