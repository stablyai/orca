// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import type { AppState } from '@/store/types'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)

const LEAF = '11111111-1111-4111-8111-111111111111'
const KEY_A = makePaneKey('tab-a', LEAF)
const KEY_B = makePaneKey('tab-b', LEAF)
const original = useAppStore.getState()
let root: Root
let container: HTMLDivElement
let rows: DashboardAgentRow[]

function Probe({
  worktreeId = 'folder-a',
  active = true
}: {
  worktreeId?: string
  active?: boolean
}) {
  rows = useWorktreeAgentRows(worktreeId, active)
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

  it('decays on an epoch-only freshness tick', () => {
    act(() => root.render(<Probe />))
    expect(rows[0].state).toBe('working')
    vi.setSystemTime(Date.now() + AGENT_STATUS_STALE_AFTER_MS + 1)
    patch({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    expect(rows[0].state).toBe('idle')
  })
})
