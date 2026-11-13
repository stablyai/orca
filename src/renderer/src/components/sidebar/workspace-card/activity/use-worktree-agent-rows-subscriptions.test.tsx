import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'
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

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(2_000_000)
  useAppStore.setState({
    tabsByWorktree: {
      'folder-a': [makeTab({ id: 'tab-a', worktreeId: 'folder-a' })],
      'ssh-b': [makeTab({ id: 'tab-b', worktreeId: 'ssh-b' })]
    },
    unifiedTabsByWorktree: {},
    agentStatusByPaneKey: acceptedAgentStatuses(
      Object.entries({
        [KEY_A]: entry(KEY_A, 'folder-a'),
        [KEY_B]: { ...entry(KEY_B, 'ssh-b'), connectionId: 'ssh:host' }
      })
    ),
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

  it('decays when its live status expires', () => {
    act(() => root.render(<Probe />))
    expect(rows[0].state).toBe('working')
    act(() => useAppStore.getState().scheduleAgentStatusFreshness())
    act(() => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 1))
    expect(rows[0].state).toBe('idle')
  })
})

it.each([100, 1000])(
  'keeps unrelated mounted rows stable after equal replay then membership changes (%i workspaces)',
  (count) => {
    const ids = Array.from({ length: count }, (_, i) => `fleet-${i}`)
    const updates = ids.map((worktreeId, index) => ({
      paneKey: makePaneKey(`tab-${worktreeId}`, LEAF),
      payload: {
        state: index % 2 ? ('done' as const) : ('working' as const),
        agentType: 'claude',
        prompt: worktreeId,
        ...(index % 2 ? { paneSleep: { ptyId: `pty-${worktreeId}` } } : {})
      },
      metadata: { providerSession: { key: 'session_id' as const, id: `session-${worktreeId}` } },
      timing: { updatedAt: 2_000_000, stateStartedAt: 2_000_000 },
      routing: { tabId: `tab-${worktreeId}`, worktreeId }
    }))
    useAppStore.setState({
      tabsByWorktree: Object.fromEntries(
        ids.map((id) => [id, [makeTab({ id: `tab-${id}`, worktreeId: id })]])
      ),
      terminalLayoutsByTabId: Object.fromEntries(
        ids.map((id) => [
          `tab-${id}`,
          {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
            },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: {}
          }
        ])
      ),
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
      agentConversationsByPaneKey: {}
    })
    useAppStore.getState().setAgentStatuses(updates)
    const outputs = new Map<string, DashboardAgentRow[]>()
    const renders = new Map<string, number>()
    function FleetProbe({ id }: { id: string }) {
      outputs.set(id, useWorktreeAgentRows(id))
      renders.set(id, (renders.get(id) ?? 0) + 1)
      return null
    }
    act(() => root.render(ids.map((id) => <FleetProbe key={id} id={id} />)))
    const before = new Map(outputs)
    const rendered = new Map(renders)
    act(() =>
      useAppStore.getState().setAgentStatuses(
        updates.map((update) => ({
          ...structuredClone(update),
          timing: { ...update.timing, isReplay: true }
        }))
      )
    )
    for (const id of ids) {
      expect(outputs.get(id)).toBe(before.get(id))
      expect(renders.get(id)).toBe(rendered.get(id))
    }
    expect(
      useAppStore.getState().agentStatusByPaneKey.get(updates[0].paneKey)?.acceptedStatusSeq
    ).toBe(2)
    const target = ids[0]
    const addedPane = makePaneKey(`tab-${target}`, '22222222-2222-4222-8222-222222222222')
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          addedPane,
          { state: 'working', agentType: 'claude', prompt: 'addressed new pane' },
          undefined,
          { updatedAt: 2_000_000, stateStartedAt: 2_000_000 },
          { tabId: `tab-${target}`, worktreeId: target }
        )
    )
    expect(outputs.get(target)).toHaveLength(2)
    act(() => useAppStore.getState().removeAgentStatus(addedPane))
    expect(outputs.get(target)).toHaveLength(1)
    for (const id of ids.slice(1)) {
      expect(outputs.get(id)).toBe(before.get(id))
      expect(renders.get(id)).toBe(rendered.get(id))
    }
  }
)

it('updates mounted card status when Done membership moves without a flag change', () => {
  const sibling = makePaneKey('tab-sibling', LEAF)
  const doneA = { ...entry(KEY_A, 'folder-a'), state: 'done' as const }
  const doneB = { ...entry(sibling, 'folder-a'), state: 'done' as const }
  const state = useAppStore.getState()
  const remote = state.agentStatusByPaneKey.get(KEY_B)!
  const paneLayout = {
    root: { type: 'leaf' as const, leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null
  }
  useAppStore.setState({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      'folder-a': [
        state.tabsByWorktree['folder-a'][0],
        makeTab({ id: 'tab-sibling', worktreeId: 'folder-a' })
      ]
    },
    ptyIdsByTabId: { 'tab-a': ['pty-a'], 'tab-sibling': ['pty-sibling'] },
    runtimePaneTitlesByTabId: { 'tab-a': { 1: '⠋ Codex' }, 'tab-sibling': { 1: 'bash' } },
    terminalLayoutsByTabId: { 'tab-a': paneLayout, 'tab-sibling': paneLayout },
    agentStatusByPaneKey: acceptedAgentStatuses([
      [KEY_A, doneA],
      [KEY_B, remote]
    ])
  })
  const outputs = new Map<string, string[]>()
  const renders = new Map<string, number>()
  function ActivityProbe({ id }: { id: string }) {
    const single = useWorktreeActivityStatus(id)
    const plural = useWorktreeActivityStatuses([id]).get(id)!
    outputs.set(id, [single, plural])
    renders.set(id, (renders.get(id) ?? 0) + 1)
    return null
  }
  act(() =>
    root.render(
      <>
        <ActivityProbe id="folder-a" />
        <ActivityProbe id="ssh-b" />
      </>
    )
  )
  expect(outputs.get('folder-a')).toEqual(['done', 'done'])
  const unrelatedRenders = renders.get('ssh-b')
  act(() =>
    useAppStore.setState((current) => ({
      agentStatusByPaneKey: current.agentStatusByPaneKey.replace([
        [KEY_A, null],
        [sibling, doneB]
      ])
    }))
  )
  expect(outputs.get('folder-a')).toEqual(['working', 'working'])
  expect(renders.get('ssh-b')).toBe(unrelatedRenders)
  act(() =>
    useAppStore.setState((current) => ({
      agentStatusByPaneKey: current.agentStatusByPaneKey.replace([
        [sibling, null],
        [KEY_A, doneA]
      ])
    }))
  )
  expect(outputs.get('folder-a')).toEqual(['done', 'done'])
  expect(renders.get('ssh-b')).toBe(unrelatedRenders)
})
