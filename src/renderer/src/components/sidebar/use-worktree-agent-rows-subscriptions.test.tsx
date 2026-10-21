// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import { makeTab } from '@/store/slices/store-test-helpers'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const LEAF = '11111111-1111-4111-8111-111111111111'
const KEY_A = makePaneKey('tab-a', LEAF)
const KEY_B = makePaneKey('tab-b', LEAF)
const original = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let rows: DashboardAgentRow[]
let renders: number

function Probe({
  worktreeId = 'folder-a',
  active = true
}: {
  worktreeId?: string
  active?: boolean
}) {
  rows = useWorktreeAgentRows(worktreeId, active)
  renders += 1
  return null
}
function entry(key: string, worktreeId: string): AgentStatusEntry {
  return {
    paneKey: key,
    worktreeId,
    state: 'working',
    agentType: 'claude',
    prompt: worktreeId,
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: []
  }
}
function patch(update: Partial<AppState>) {
  act(() => useAppStore.setState(update))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  useAppStore.setState({
    tabsByWorktree: {
      'folder-a': [makeTab({ id: 'tab-a', worktreeId: 'folder-a' })],
      'ssh-b': [makeTab({ id: 'tab-b', worktreeId: 'ssh-b' })]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: {
      [KEY_A]: entry(KEY_A, 'folder-a'),
      [KEY_B]: { ...entry(KEY_B, 'ssh-b'), connectionId: 'ssh:host' }
    },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  })
  renders = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(original, true)
  vi.useRealTimers()
})

describe('mounted worktree agent row subscriptions', () => {
  it('listens once while active and releases its listener while inactive', () => {
    const baseline = readStoreListenerCount() ?? 0
    act(() => root.render(<Probe />))
    expect(readStoreListenerCount()).toBe(baseline + 1)
    expect(rows[0].entry.prompt).toBe('folder-a')
    act(() => root.render(<Probe active={false} />))
    expect(readStoreListenerCount()).toBe(baseline)
    expect(rows).toEqual([])
    const before = renders
    patch({ activeWorktreeId: 'ssh-b' })
    expect(renders).toBe(before)
    patch({
      agentStatusByPaneKey: {
        ...useAppStore.getState().agentStatusByPaneKey,
        [KEY_A]: { ...entry(KEY_A, 'folder-a'), prompt: 'changed while disabled' }
      }
    })
    act(() => root.render(<Probe />))
    expect(rows[0].entry.prompt).toBe('changed while disabled')
    expect(readStoreListenerCount()).toBe(baseline + 1)
  })

  it('switches worktrees and applies an SSH status update immediately', () => {
    act(() => root.render(<Probe />))
    act(() => root.render(<Probe worktreeId="ssh-b" />))
    expect(rows[0].paneKey).toBe(KEY_B)
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_B,
          { state: 'blocked', agentType: 'claude', prompt: 'remote permission' },
          undefined,
          { updatedAt: Date.now() + 1 },
          { tabId: 'tab-b', worktreeId: 'ssh-b', connectionId: 'ssh:host' }
        )
    )
    expect(rows[0].entry.prompt).toBe('remote permission')
    expect(rows[0].state).toBe('blocked')
  })

  it('keeps unrelated cards stable while a working agent reports new tool output', () => {
    act(() => root.render(<Probe />))
    const beforeRows = rows
    const before = renders
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_B,
          { state: 'working', agentType: 'claude', prompt: 'new output', toolName: 'Read' },
          undefined,
          { updatedAt: Date.now() + 1 },
          { tabId: 'tab-b', worktreeId: 'ssh-b', connectionId: 'ssh:host' }
        )
    )
    expect(rows).toBe(beforeRows)
    expect(renders).toBe(before)
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          KEY_A,
          { state: 'working', agentType: 'claude', prompt: 'local output', toolName: 'Edit' },
          undefined,
          { updatedAt: Date.now() + 2 },
          { tabId: 'tab-a', worktreeId: 'folder-a' }
        )
    )
    expect(rows[0].entry.toolName).toBe('Edit')
    expect(renders).toBe(before + 1)
  })

  it('decays on an epoch-only freshness tick', () => {
    act(() => root.render(<Probe />))
    expect(rows[0].state).toBe('working')
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    patch({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    expect(rows[0].state).toBe('idle')
  })

  it('observes title, PTY, layout, orchestration, foreground, migration and retention inputs', () => {
    act(() => root.render(<Probe />))
    const updates: Partial<AppState>[] = [
      { runtimePaneTitlesByTabId: { 'tab-a': { 0: 'Claude Code' } } },
      { ptyIdsByTabId: { 'tab-a': ['pty-a'] } },
      {
        terminalLayoutsByTabId: {
          'tab-a': {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null
          }
        }
      },
      {
        runtimeAgentOrchestrationByPaneKey: {
          [KEY_A]: { taskId: 'task', dispatchId: 'dispatch', taskTitle: 'New task' }
        }
      },
      { paneForegroundAgentByPaneKey: { [KEY_A]: { agent: 'claude', shellForeground: false } } },
      {
        migrationUnsupportedByPtyId: {
          legacy: {
            ptyId: 'legacy',
            worktreeId: 'folder-a',
            tabId: 'tab-a',
            leafId: LEAF,
            paneKey: KEY_A,
            reason: 'legacy-numeric-pane-key',
            source: 'local',
            updatedAt: Date.now()
          }
        }
      },
      {
        retainedAgentsByPaneKey: {
          [KEY_B]: {
            entry: entry(KEY_B, 'folder-a'),
            worktreeId: 'folder-a',
            tab: makeTab({ id: 'tab-b', worktreeId: 'folder-a' }),
            agentType: 'claude',
            startedAt: Date.now()
          }
        }
      }
    ]
    for (const update of updates) {
      const before = rows
      patch(update)
      expect(rows).not.toBe(before)
    }
  })
})
