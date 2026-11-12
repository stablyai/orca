import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { expandWorkspaceUnreadTargets, workspaceUnreadTarget } from './worktree-card-slot-targets'

const WS = 'ws-scale'
const REMOTE = 'runtime:host-B' as const
const MARKER = { at: 1, kind: 'agent-completion' } as never

type Counter = { visits: number }

/** Count element reads so a per-tab `Array.find` shows up as quadratic visits. */
function countingArray<T extends object>(items: T[], counter: Counter): T[] {
  return new Proxy(items, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        counter.visits++
      }
      return Reflect.get(target, prop, receiver)
    }
  })
}

/**
 * T marked terminal tabs alternating local/remote, one structured chat whose old session also
 * left a completion, and C unrelated completion markers in other workspaces.
 */
function buildState(tabCount: number, unrelatedCount: number, counter: Counter): AppState {
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
  const completions: Record<string, unknown> = {}
  for (const tab of terminals) {
    completions[`${tab.id}:leaf`] = MARKER
  }
  completions[structuredAgentSessionPaneKey('chat', 'session-1')] = MARKER
  completions[structuredAgentSessionPaneKey('chat', 'session-2')] = MARKER
  for (let j = 0; j < unrelatedCount; j++) {
    completions[`other${j}:leaf`] = MARKER
  }
  return {
    workspacesMarkedUnreadByUser: {},
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: completions,
    tabsByWorktree: { [WS]: countingArray(terminals, counter) },
    unifiedTabsByWorktree: { [WS]: countingArray(unified, counter) },
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {}
  } as unknown as AppState
}

/** Visits = tab element reads + pane-key parses (paneKeyTabId uses indexOf). */
function measure(tabCount: number, unrelatedCount: number): number {
  const counter: Counter = { visits: 0 }
  const state = buildState(tabCount, unrelatedCount, counter)
  const indexOf = vi.spyOn(String.prototype, 'indexOf')
  expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, REMOTE)])
  expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, 'local')])
  const parses = indexOf.mock.calls.length
  indexOf.mockRestore()
  return counter.visits + parses
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('expandWorkspaceUnreadTargets scaling', () => {
  it('grows linearly with marked tabs and unrelated completion markers', () => {
    const small = measure(20, 200)
    const large = measure(200, 2000)
    // Linear work scales ~10x; the former T×C and per-tab find scans scaled ~100x.
    expect(large / small).toBeLessThan(15)
  })

  it('keeps host ownership and structured-session filtering', () => {
    const state = buildState(4, 3, { visits: 0 })
    const remote = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, REMOTE)])
    expect(remote.map((target) => [target.tabId, target.unreadPaneKeys])).toEqual([
      ['t0', ['t0:leaf']],
      ['t2', ['t2:leaf']],
      ['chat', [structuredAgentSessionPaneKey('chat', 'session-2')]]
    ])
    const local = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, 'local')])
    expect(local.map((target) => [target.tabId, target.unreadPaneKeys])).toEqual([
      ['t1', ['t1:leaf']],
      ['t3', ['t3:leaf']]
    ])
  })

  it('keeps a manual mark as its own target alongside tab targets', () => {
    const state = buildState(2, 0, { visits: 0 })
    state.workspacesMarkedUnreadByUser = {
      [composeWorktreeHostIdentity('local', WS)]: true
    } as never
    const local = expandWorkspaceUnreadTargets(state, [workspaceUnreadTarget(WS, 1, 'local')])
    expect(
      local.map((target) => target.tabId ?? (target.markedByUser ? 'manual' : 'workspace'))
    ).toEqual(['t1', 'manual'])
  })
})
