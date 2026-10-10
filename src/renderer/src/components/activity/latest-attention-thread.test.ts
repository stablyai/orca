import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { resolveLatestAttentionThread, type LatestAttentionSource } from './latest-attention-thread'
import {
  LEAF_ID,
  LEAF_ID_2,
  makeRepo,
  makeTabWithIds,
  makeWorktreeWithId
} from './ActivityPrototypePage-test-fixtures'

const NOW = 100_000

function request(
  tabId: string,
  startedAt: number,
  state: AgentStatusEntry['state'] = 'waiting'
): AgentStatusEntry {
  return {
    paneKey: makePaneKey(tabId, LEAF_ID),
    worktreeId: `wt-${tabId}`,
    state,
    stateStartedAt: startedAt,
    updatedAt: NOW,
    prompt: 'Synthetic input request',
    terminalTitle: 'Synthetic agent',
    agentType: 'codex',
    stateHistory: []
  }
}

function sourceFor(...entries: AgentStatusEntry[]): LatestAttentionSource {
  const worktrees = entries.map((entry) => makeWorktreeWithId(entry.worktreeId ?? 'wt-missing'))
  const source: LatestAttentionSource = {
    agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry])),
    runtimeAgentOrchestrationByPaneKey: {},
    tabsByWorktree: Object.fromEntries(
      worktrees.map((wt, index) => [
        wt.id,
        [makeTabWithIds(entries[index]!.paneKey.split(':')[0]!, wt.id)]
      ])
    ),
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {},
    sleepingAgentSessionsByPaneKey: {},
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': worktrees },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    floatingWorkspacePath: '/synthetic/floating',
    getKnownWorktreeById: (id, host) => findKnownWorktreeById(source, id, host),
    getFreshFolderWorkspacePathStatus: () => null,
    acknowledgedAgentsByPaneKey: {},
    agentsShowChildAgents: false,
    settings: null
  }
  return source
}

describe('latest outstanding agent request', () => {
  it('selects the newest waiting or blocked request, regardless of heartbeat order', () => {
    const old = { ...request('older', 90_000, 'blocked'), updatedAt: NOW + 100 }
    const latest = request('latest', 99_000)
    const source = sourceFor(old, latest, request('completed', NOW, 'done'))

    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(latest.paneKey)
  })

  it('keeps a read request eligible until the agent resumes', () => {
    const entry = request('pending', 99_000)
    const source = sourceFor(entry)
    source.acknowledgedAgentsByPaneKey[entry.paneKey] = NOW

    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(entry.paneKey)
    source.agentStatusByPaneKey[entry.paneKey] = { ...entry, state: 'working' }
    expect(resolveLatestAttentionThread(source, NOW)).toBeNull()
  })

  it('ignores historical requests after an answer or completion', () => {
    const entry = request('answered', 99_000, 'working')
    entry.stateHistory = [{ state: 'waiting', startedAt: 98_000, prompt: 'Old question' }]
    expect(resolveLatestAttentionThread(sourceFor(entry), NOW)).toBeNull()
    expect(resolveLatestAttentionThread(sourceFor(request('done', NOW, 'done')), NOW)).toBeNull()
  })

  it('ignores stale, restored-unconfirmed, and invalid status timestamps', () => {
    const stale = { ...request('stale', 1), updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }
    const unconfirmed = { ...request('unconfirmed', 99_000), restoredUnconfirmed: true }
    const invalid = request('invalid', Infinity)
    expect(resolveLatestAttentionThread(sourceFor(stale, unconfirmed, invalid), NOW)).toBeNull()
  })

  it('skips a deleted workspace and reaches an older pending request', () => {
    const older = request('older', 90_000)
    const latest = request('deleted', 99_000)
    const source = sourceFor(older, latest)
    source.worktreesByRepo['repo-1'] = [makeWorktreeWithId('wt-older')]
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(older.paneKey)
  })

  it('ignores archived workspaces', () => {
    const entry = request('archived', 99_000)
    const source = sourceFor(entry)
    source.worktreesByRepo['repo-1'] = [{ ...makeWorktreeWithId('wt-archived'), isArchived: true }]
    expect(resolveLatestAttentionThread(source, NOW)).toBeNull()
  })

  it('skips a confirmed removed split pane', () => {
    const older = request('older', 90_000)
    const removed = request('removed', 99_000)
    const source = sourceFor(older, removed)
    source.terminalLayoutsByTabId.removed = {
      root: { type: 'leaf', leafId: LEAF_ID_2 },
      activeLeafId: LEAF_ID_2,
      expandedLeafId: null
    }
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(older.paneKey)
  })

  it('allows a cold remote request before its tab or layout is resident', () => {
    const entry = { ...request('cold', 99_000), connectionId: 'test-host' }
    const source = sourceFor(entry)
    source.worktreesByRepo['repo-1'] = [
      { ...makeWorktreeWithId('wt-cold'), hostId: 'ssh:test-host' }
    ]
    source.tabsByWorktree = {}
    const target = resolveLatestAttentionThread(source, NOW)
    expect(target?.paneKey).toBe(entry.paneKey)
    expect(target?.worktree.hostId).toBe('ssh:test-host')
  })

  it('does not replace a vanished remote owner with a local workspace with the same ID', () => {
    const older = request('older', 90_000)
    const remote = { ...request('shared', 99_000), connectionId: 'test-host' }
    const source = sourceFor(older, remote)
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(older.paneKey)
  })

  it('skips a closed terminal tab while another request remains reachable', () => {
    const older = request('older', 90_000)
    const closed = request('closed', 99_000)
    const source = sourceFor(older, closed)
    source.tabsByWorktree['wt-closed'] = []
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(older.paneKey)
  })

  it('skips a closed floating terminal', () => {
    const entry = { ...request('floating', 99_000), worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    const source = sourceFor(entry)
    source.tabsByWorktree = {}
    expect(resolveLatestAttentionThread(source, NOW)).toBeNull()
  })

  it('keeps a present floating terminal reachable', () => {
    const entry = { ...request('floating', 99_000), worktreeId: FLOATING_TERMINAL_WORKTREE_ID }
    expect(resolveLatestAttentionThread(sourceFor(entry), NOW)?.paneKey).toBe(entry.paneKey)
  })

  it('includes a folder workspace without a Git repository', () => {
    const entry = { ...request('folder', 99_000), worktreeId: 'folder:synthetic' }
    const source = sourceFor(entry)
    source.repos = []
    source.worktreesByRepo = {}
    source.folderWorkspaces = [
      {
        id: 'synthetic',
        projectGroupId: 'group',
        name: 'Synthetic folder',
        folderPath: '/synthetic/folder',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ]
    expect(resolveLatestAttentionThread(source, NOW)?.worktree.id).toBe('folder:synthetic')
    source.getFreshFolderWorkspacePathStatus = () => ({
      path: '/synthetic/folder',
      exists: false,
      reason: 'missing'
    })
    expect(resolveLatestAttentionThread(source, NOW)).toBeNull()
  })

  it('respects the child-agent visibility setting', () => {
    const parent = request('parent', 90_000, 'working')
    const child = {
      ...request('child', 99_000),
      orchestration: { taskId: 'task', dispatchId: 'dispatch', parentPaneKey: parent.paneKey }
    }
    const source = sourceFor(parent, child)
    expect(resolveLatestAttentionThread(source, NOW)).toBeNull()
    source.agentsShowChildAgents = true
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(child.paneKey)
  })

  it('ignores malformed pane identities', () => {
    const entry = { ...request('invalid-key', 99_000), paneKey: 'malformed' }
    expect(resolveLatestAttentionThread(sourceFor(entry), NOW)).toBeNull()
  })

  it('includes structured agent sessions even when a terminal layout has no matching leaf', () => {
    const entry = request('chat', 99_000)
    const source = sourceFor(entry)
    source.tabsByWorktree = {}
    source.unifiedTabsByWorktree['wt-chat'] = [
      {
        id: 'chat',
        entityId: 'session',
        groupId: 'group',
        worktreeId: 'wt-chat',
        contentType: 'agent-session',
        label: 'Synthetic chat',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }
    ]
    source.terminalLayoutsByTabId.chat = {
      root: { type: 'leaf', leafId: LEAF_ID_2 },
      activeLeafId: LEAF_ID_2,
      expandedLeafId: null
    }
    expect(resolveLatestAttentionThread(source, NOW)?.paneKey).toBe(entry.paneKey)
  })

  it('uses a deterministic tie-break when requests have the same timestamp', () => {
    const a = request('a', 99_000)
    const b = request('b', 99_000)
    expect(resolveLatestAttentionThread(sourceFor(b, a), NOW)?.paneKey).toBe(a.paneKey)
    expect(resolveLatestAttentionThread(sourceFor(a, b), NOW)?.paneKey).toBe(a.paneKey)
  })

  it('passes an empty inventory through without a target', () => {
    expect(resolveLatestAttentionThread(sourceFor(), NOW)).toBeNull()
  })
})
