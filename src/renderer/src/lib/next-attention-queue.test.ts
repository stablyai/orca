import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import type { AttentionOrderWorkspace } from '@/components/sidebar/attention-order-workspaces'
import { buildAttentionQueue, type AttentionTarget } from './next-attention-queue'

const NOW = new Date('2026-03-27T12:00:00.000Z').getTime()
const LEAF_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_2 = '22222222-2222-4222-8222-222222222222'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    branch: `refs/heads/${id}`,
    head: 'abc',
    isBare: false,
    isMainWorktree: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    comment: '',
    isUnread: false,
    isPinned: false,
    displayName: id,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function terminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: 'pty',
    worktreeId,
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function unifiedTab(
  id: string,
  worktreeId: string,
  groupId: string,
  contentType: Tab['contentType'],
  entityId: string
): Tab {
  return {
    id,
    entityId,
    groupId,
    worktreeId,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(id: string, worktreeId: string, tabOrder: string[]): TabGroup {
  return { id, worktreeId, activeTabId: tabOrder[0] ?? null, tabOrder }
}

function split(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_1 },
      second: { type: 'leaf', leafId: LEAF_2 }
    },
    activeLeafId: LEAF_1,
    expandedLeafId: null
  }
}

function entry(
  paneKey: string,
  state: AgentStatusEntry['state'],
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW - 30_000,
    stateStartedAt: NOW - 30_000,
    agentType: 'codex',
    paneKey,
    stateHistory: [],
    ...overrides
  }
}

function makeState(overrides: Partial<AppState>): AppState {
  return { ...useAppStore.getInitialState(), ...overrides }
}

function brief(queue: AttentionTarget[]): string[] {
  return queue.map((target) =>
    [target.worktreeId, target.level, target.unifiedTabId ?? target.terminalTabId, target.leafId]
      .filter(Boolean)
      .join('/')
  )
}

function workspace(
  id: string,
  overrides: Partial<AttentionOrderWorkspace> = {}
): AttentionOrderWorkspace {
  return { id, identityHostId: 'local', isUnread: false, lastActivityAt: 0, ...overrides }
}

const order = (...ids: string[]) => ids.map((id) => workspace(id))

describe('buildAttentionQueue', () => {
  it('lists workspaces in sidebar order and panes in layout order', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a'), worktree('b')] },
      tabsByWorktree: { a: [terminalTab('ta', 'a')], b: [terminalTab('tb', 'b')] },
      terminalLayoutsByTabId: { ta: split(), tb: split() },
      agentStatusByPaneKey: {
        [`ta:${LEAF_2}`]: entry(`ta:${LEAF_2}`, 'waiting'),
        [`ta:${LEAF_1}`]: entry(`ta:${LEAF_1}`, 'blocked'),
        [`tb:${LEAF_1}`]: entry(`tb:${LEAF_1}`, 'blocked')
      }
    })

    expect(brief(buildAttentionQueue(state, order('b', 'a'), NOW))).toEqual([
      `b/pane/tb/${LEAF_1}`,
      `a/pane/ta/${LEAF_1}`,
      `a/pane/ta/${LEAF_2}`
    ])
  })

  it('ignores working agents and stale waiting rows', () => {
    const stale = NOW - 60 * 60 * 1000
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [terminalTab('ta', 'a')] },
      terminalLayoutsByTabId: { ta: split() },
      agentStatusByPaneKey: {
        [`ta:${LEAF_1}`]: entry(`ta:${LEAF_1}`, 'working'),
        [`ta:${LEAF_2}`]: entry(`ta:${LEAF_2}`, 'waiting', {
          updatedAt: stale,
          stateStartedAt: stale
        })
      }
    })

    expect(buildAttentionQueue(state, order('a'), NOW)).toEqual([])
  })

  it('targets unread completion and bell panes, and falls back to the tab for a tab-only bell', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [terminalTab('t1', 'a'), terminalTab('t2', 'a')] },
      terminalLayoutsByTabId: { t1: split(), t2: split() },
      unreadAgentCompletionPanes: { [`t1:${LEAF_2}`]: 'agent-completion' },
      unreadTerminalTabs: { t2: 'terminal-bell' }
    })

    expect(brief(buildAttentionQueue(state, order('a'), NOW))).toEqual([
      `a/pane/t1/${LEAF_2}`,
      'a/tab/t2'
    ])
  })

  it('skips markers orphaned by a closed tab', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [] },
      unreadTerminalTabs: { gone: 'terminal-bell' },
      unreadAgentCompletionPanes: { [`gone:${LEAF_1}`]: 'agent-completion' }
    })

    expect(buildAttentionQueue(state, order('a'), NOW)).toEqual([])
  })

  it('targets the tab when a permission title has no layout to place it in', () => {
    const tab = { ...terminalTab('ta', 'a'), title: '⚠ Claude needs your permission' }
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [tab] },
      ptyIdsByTabId: { ta: ['pty-1'] }
    })

    expect(brief(buildAttentionQueue(state, order('a'), NOW))).toEqual(['a/tab/ta'])
  })

  it('places a live permission title on its pane even when a stale hook covers that pane', () => {
    const stale = NOW - 60 * 60 * 1000
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [terminalTab('ta', 'a')] },
      terminalLayoutsByTabId: { ta: split() },
      ptyIdsByTabId: { ta: ['pty-1', 'pty-2'] },
      runtimePaneTitlesByTabId: { ta: { 2: '⚠ Claude needs your permission' } },
      agentStatusByPaneKey: {
        [`ta:${LEAF_2}`]: entry(`ta:${LEAF_2}`, 'working', {
          updatedAt: stale,
          stateStartedAt: stale
        })
      }
    })

    expect(brief(buildAttentionQueue(state, order('a'), NOW))).toEqual([`a/pane/ta/${LEAF_2}`])
  })

  it('reads the unread flag of the ordered row on its own host', () => {
    const queue = buildAttentionQueue(
      makeState({}),
      [
        workspace('folder:f', { executionHostId: 'local' }),
        workspace('folder:f', {
          identityHostId: 'runtime:box',
          executionHostId: 'runtime:box',
          isUnread: true
        })
      ],
      NOW
    )

    expect(queue.map((target) => target.workspaceIdentity)).toEqual(['runtime:box|folder:f'])
  })

  it('targets a native chat tab that is blocked without any unread marker', () => {
    const chat = unifiedTab('chat-1', 'a', 'g1', 'agent-session', 'session-1')
    const paneKey = structuredAgentSessionPaneKey('chat-1', 'session-1')
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      unifiedTabsByWorktree: { a: [chat] },
      groupsByWorktree: { a: [group('g1', 'a', ['chat-1'])] },
      agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'blocked') }
    })

    expect(buildAttentionQueue(state, order('a'), NOW)).toEqual([
      {
        workspaceIdentity: 'local|a',
        worktreeId: 'a',
        level: 'tab',
        tabKind: 'agent-session',
        unifiedTabId: 'chat-1'
      }
    ])
  })

  it('ignores a chat completion left by a superseded session', () => {
    const chat = unifiedTab('chat-1', 'a', 'g1', 'agent-session', 'session-2')
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      unifiedTabsByWorktree: { a: [chat] },
      groupsByWorktree: { a: [group('g1', 'a', ['chat-1'])] },
      unreadAgentCompletionPanes: {
        [structuredAgentSessionPaneKey('chat-1', 'session-1')]: 'agent-completion'
      }
    })

    expect(buildAttentionQueue(state, order('a'), NOW)).toEqual([])
  })

  it('walks tab groups in their stored order whichever group is active', () => {
    const tabs = ['t1', 't2', 't3'].map((id) => terminalTab(id, 'a'))
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: tabs },
      terminalLayoutsByTabId: { t1: split(), t2: split(), t3: split() },
      unifiedTabsByWorktree: {
        a: [
          unifiedTab('u1', 'a', 'g1', 'terminal', 't1'),
          unifiedTab('u2', 'a', 'g2', 'terminal', 't2'),
          unifiedTab('u3', 'a', 'g3', 'terminal', 't3')
        ]
      },
      groupsByWorktree: {
        a: [group('g1', 'a', ['u1']), group('g2', 'a', ['u2']), group('g3', 'a', ['u3'])]
      },
      activeGroupIdByWorktree: { a: 'g3' },
      agentStatusByPaneKey: Object.fromEntries(
        ['t1', 't2', 't3'].map((id) => [`${id}:${LEAF_1}`, entry(`${id}:${LEAF_1}`, 'waiting')])
      )
    })

    expect(brief(buildAttentionQueue(state, order('a'), NOW))).toEqual([
      `a/pane/u1/${LEAF_1}`,
      `a/pane/u2/${LEAF_1}`,
      `a/pane/u3/${LEAF_1}`
    ])
  })

  it('keeps one target for a terminal shown in two split copies', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      tabsByWorktree: { a: [terminalTab('t1', 'a')] },
      terminalLayoutsByTabId: { t1: split() },
      unifiedTabsByWorktree: {
        a: [
          unifiedTab('u1', 'a', 'g1', 'terminal', 't1'),
          unifiedTab('u1-copy', 'a', 'g2', 'terminal', 't1')
        ]
      },
      groupsByWorktree: { a: [group('g1', 'a', ['u1']), group('g2', 'a', ['u1-copy'])] },
      unreadAgentCompletionPanes: { [`t1:${LEAF_1}`]: 'agent-completion' }
    })

    expect(brief(buildAttentionQueue(state, order('a'), NOW))).toEqual([`a/pane/u1/${LEAF_1}`])
  })

  it('falls back to the workspace for a manual unread flag only when nothing finer exists', () => {
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a'), worktree('b')] },
      tabsByWorktree: { b: [terminalTab('tb', 'b')] },
      terminalLayoutsByTabId: { tb: split() },
      unreadAgentCompletionPanes: { [`tb:${LEAF_1}`]: 'agent-completion' }
    })
    const unread = [workspace('a', { isUnread: true }), workspace('b', { isUnread: true })]

    expect(brief(buildAttentionQueue(state, unread, NOW))).toEqual([
      'a/workspace',
      `b/pane/tb/${LEAF_1}`
    ])
  })

  it('targets the workspace with the owner pane for a status whose tab is not mirrored yet', () => {
    const paneKey = `remote-tab:${LEAF_1}`
    const state = makeState({
      worktreesByRepo: { 'repo-1': [worktree('a')] },
      agentStatusByPaneKey: { [paneKey]: entry(paneKey, 'waiting', { worktreeId: 'a' }) }
    })

    expect(buildAttentionQueue(state, order('a'), NOW)).toEqual([
      { workspaceIdentity: 'local|a', worktreeId: 'a', level: 'workspace', ownerPaneKey: paneKey }
    ])
  })

  it('keeps same-id workspaces on two hosts apart', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [worktree('a', { hostId: 'local' }), worktree('a', { hostId: 'ssh:box' })]
      }
    })

    const queue = buildAttentionQueue(
      state,
      [
        workspace('a', { executionHostId: 'local', isUnread: true }),
        workspace('a', { identityHostId: 'ssh:box', executionHostId: 'ssh:box', isUnread: true })
      ],
      NOW
    )

    expect(queue.map((target) => target.workspaceIdentity)).toEqual(['local|a', 'ssh:box|a'])
  })

  it('does not repeat one tab under a same-id workspace on another host', () => {
    const state = makeState({
      worktreesByRepo: {
        'repo-1': [worktree('a', { hostId: 'local' }), worktree('a', { hostId: 'ssh:box' })]
      },
      tabsByWorktree: { a: [terminalTab('ta', 'a')] },
      unreadTerminalTabs: { ta: 'terminal-bell' }
    })

    const queue = buildAttentionQueue(
      state,
      [
        workspace('a', { executionHostId: 'local' }),
        workspace('a', { identityHostId: 'ssh:box', executionHostId: 'ssh:box' })
      ],
      NOW
    )

    expect(brief(queue)).toEqual(['a/tab/ta'])
  })
})
