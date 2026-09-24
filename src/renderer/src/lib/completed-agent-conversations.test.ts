// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { createCompletedConversationsSelector } from './completed-agent-conversations'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import {
  makeRepo,
  makeTab,
  makeWorktree,
  makeRetainedDoneEntry,
  PANE_KEY
} from '@/components/activity/ActivityPrototypePage-test-fixtures'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { getDefaultSettings } from '../../../shared/constants'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { makePaneKey } from '../../../shared/stable-pane-id'

function scenario() {
  const store = createUIStore()
  const repo = makeRepo()
  const worktree = makeWorktree()
  const tab = makeTab()
  const entry = makeRetainedDoneEntry(tab).entry
  store.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    folderWorkspaces: [],
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [worktree.id]: [tab] },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: { [PANE_KEY]: entry },
    retainedAgentsByPaneKey: {},
    runtimeAgentOrchestrationByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    activityClearedAtByPaneKey: {},
    settings: getDefaultSettings('/test-home'),
    runtimeEnvironments: [],
    sshTargetLabels: new Map(),
    removedSshTargetLabels: new Map(),
    getKnownWorktreeById: (id) => (id === worktree.id ? worktree : undefined)
  })
  return { store, entry, tab, worktree, select: createCompletedConversationsSelector() }
}

describe('completed conversations projection', () => {
  it('keeps labels unique when a title already has a numeric suffix', () => {
    const { store, worktree, tab, entry, select } = scenario()
    const tabs = [
      { ...tab, id: 'tab-a' },
      { ...tab, id: 'tab-b' },
      { ...tab, id: 'tab-c' }
    ]
    const prompts = ['A', 'A', 'A (1)']
    const entries = Object.fromEntries(
      tabs.map((item, index) => {
        const paneKey = makePaneKey(item.id, '11111111-1111-4111-8111-111111111111')
        return [
          paneKey,
          {
            ...entry,
            paneKey,
            tabId: item.id,
            prompt: prompts[index],
            stateStartedAt: 1000 + index
          }
        ]
      })
    )
    store.setState({
      tabsByWorktree: { [worktree.id]: tabs },
      agentStatusByPaneKey: entries
    })
    const labels = select(store.getState()).entries.map((item) => item.label)
    expect(labels).toHaveLength(3)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('keeps all conversations, independent of Activity filters and the 80-event cap', () => {
    const { store, worktree, tab, entry, select } = scenario()
    const tabs = Array.from({ length: 105 }, (_, index) => ({ ...tab, id: `tab-${index}` }))
    const entries = Object.fromEntries(
      tabs.map((item, index) => {
        const paneKey = makePaneKey(item.id, '11111111-1111-4111-8111-111111111111')
        return [paneKey, { ...entry, paneKey, stateStartedAt: 1000 + index }]
      })
    )
    store.setState({
      tabsByWorktree: { [worktree.id]: tabs },
      agentStatusByPaneKey: entries,
      agentsFilterRepoIds: ['hidden']
    })
    const projected = select(store.getState())
    expect(projected.entries).toHaveLength(105)
    expect([...projected.threads.values()][0].latestTimestamp).toBe(1104)
    expect(new Set(projected.entries.map((item) => item.id)).size).toBe(105)
  })

  it('caps Dock entries without dropping the newest conversations', () => {
    const { store, worktree, tab, entry, select } = scenario()
    const tabs = Array.from({ length: 201 }, (_, index) => ({ ...tab, id: `tab-${index}` }))
    const entries = Object.fromEntries(
      tabs.map((item, index) => {
        const paneKey = makePaneKey(item.id, '11111111-1111-4111-8111-111111111111')
        return [paneKey, { ...entry, paneKey, stateStartedAt: 1000 + index }]
      })
    )
    store.setState({
      tabsByWorktree: { [worktree.id]: tabs },
      agentStatusByPaneKey: entries
    })
    const projected = select(store.getState())
    expect(projected.entries).toHaveLength(200)
    expect([...projected.threads.values()][0].latestTimestamp).toBe(1200)
  })

  it('removes acknowledged turns and rejects old menu identities after another completion', () => {
    const { store, entry, select } = scenario()
    const old = select(store.getState()).entries[0].id
    store.setState({ acknowledgedAgentsByPaneKey: { [PANE_KEY]: entry.stateStartedAt } })
    expect(select(store.getState()).entries).toEqual([])
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: { ...entry, stateStartedAt: 2000 } } })
    expect(select(store.getState()).entries).toHaveLength(1)
    expect(select(store.getState()).threads.has(old)).toBe(false)
  })

  it.each<Partial<AgentStatusEntry>>([
    { state: 'working', updatedAt: Date.now() },
    { state: 'blocked' },
    { state: 'waiting' },
    { interrupted: true },
    { sessionBoundary: true },
    { restoredUnconfirmed: true }
  ])('does not call a non-completion done: %j', (change) => {
    const { store, entry, select } = scenario()
    store.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          ...entry,
          stateHistory: [{ state: 'done', startedAt: 1, prompt: 'Old' }],
          ...change
        }
      },
      unreadTerminalTabs: { 'tab-1': 'terminal-bell' }
    })
    expect(select(store.getState()).entries).toEqual([])
  })

  it('retains completed details after a tab closes and honors Clear completed', () => {
    const { store, tab, select } = scenario()
    store.setState({
      tabsByWorktree: {},
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: { [PANE_KEY]: makeRetainedDoneEntry(tab) }
    })
    expect(select(store.getState()).entries).toHaveLength(1)
    store.setState({ activityClearedAtByPaneKey: { [PANE_KEY]: 1000 } })
    expect(select(store.getState()).entries).toEqual([])
  })

  it('reuses the published snapshot across heartbeats and unrelated changes', () => {
    const { store, entry, select } = scenario()
    const first = select(store.getState())
    store.setState({ activeView: 'activity' })
    expect(select(store.getState())).toBe(first)
    store.setState({ agentStatusByPaneKey: { [PANE_KEY]: { ...entry, updatedAt: 9000 } } })
    expect(select(store.getState()).entries).toBe(first.entries)
  })
  it('projects native chat without requiring a terminal tab', () => {
    const { store, worktree, select } = scenario()
    store.setState({
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'tab-1',
            entityId: 'session-1',
            groupId: 'group-1',
            worktreeId: worktree.id,
            contentType: 'agent-session',
            executionHostId: 'local',
            label: 'Native chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            agentSessionAgent: 'codex'
          }
        ]
      }
    })
    expect(select(store.getState()).entries).toHaveLength(1)
    expect([...select(store.getState()).threads.values()][0].tab.id).toBe('tab-1')
  })

  it('preserves SSH ownership and never treats disconnection as a completion', () => {
    const { store, worktree, entry, select } = scenario()
    const remote = { ...worktree, hostId: 'ssh:builder' as const }
    store.setState({
      worktreesByRepo: { [worktree.repoId]: [remote] },
      getKnownWorktreeById: () => remote,
      sshTargetLabels: new Map([['builder', 'Build machine']]),
      agentStatusByPaneKey: { [PANE_KEY]: { ...entry, connectionId: 'builder' } }
    })
    const result = select(store.getState())
    expect(result.entries[0].label).toContain('Build machine')
    expect(result.entries[0].id).toContain('ssh:builder')
    store.setState({
      agentStatusByPaneKey: {
        [PANE_KEY]: { ...entry, connectionId: 'builder', state: 'working', updatedAt: 1 }
      }
    })
    expect(select(store.getState()).entries).toEqual([])
  })

  it('does not show an old retained completion over a newer live turn', () => {
    const { store, tab, entry, select } = scenario()
    store.setState({
      retainedAgentsByPaneKey: { [PANE_KEY]: makeRetainedDoneEntry(tab) },
      agentStatusByPaneKey: { [PANE_KEY]: { ...entry, state: 'working', updatedAt: 1 } }
    })
    expect(select(store.getState()).entries).toEqual([])
  })

  it('includes ordinary folder workspaces without a Git repository', () => {
    const { store, tab, select } = scenario()
    const folder: FolderWorkspace = {
      id: 'notes',
      projectGroupId: 'group',
      name: 'Notes',
      folderPath: '/notes',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: true,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 1,
      updatedAt: 1
    }
    const worktree = folderWorkspaceToWorktree(folder)
    store.setState({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [folder],
      getKnownWorktreeById: () => worktree,
      tabsByWorktree: { [worktree.id]: [{ ...tab, worktreeId: worktree.id }] }
    })
    expect(select(store.getState()).entries[0].label).toContain('Notes')
    expect(select(store.getState()).entries[0].id).toContain(worktree.id)
  })
})
