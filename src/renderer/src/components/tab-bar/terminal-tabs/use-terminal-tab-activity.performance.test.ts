// @vitest-environment happy-dom
// Guards #15776: a process-read foreground change in one pane reruns the activity heuristic for
// that pane's tab only, not for every mounted terminal tab.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveWorktreeStatus } from '@/lib/workspace/activity/worktree-status'
import { useAppStore } from '../../../store/index'
import { useTerminalTabActivity } from './use-terminal-tab-activity'

vi.mock('../../../store/index', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create<Record<string, unknown>>(() => ({})) }
})
vi.mock('@/lib/workspace/activity/worktree-status', async (importOriginal) => {
  const actual = await importOriginal<{ resolveWorktreeStatus: typeof resolveWorktreeStatus }>()
  return { ...actual, resolveWorktreeStatus: vi.fn(actual.resolveWorktreeStatus) }
})

afterEach(cleanup)

const TAB_COUNT = 200
// A hand-started agent's providerless spinner title; only process-read evidence attributes it.
const SPINNER_TITLE = '◐ Install cursor plugins'

function leafIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function seedTabs(count: number): { id: string; title: string }[] {
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    title: SPINNER_TITLE
  }))
  useAppStore.setState({
    agentStatusByPaneKey: new Map(),
    agentStatusEpoch: 0,
    runtimePaneTitlesByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, { 1: SPINNER_TITLE }])),
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab, index) => [tab.id, [`pty-${index}`]])),
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab, index) => [
        tab.id,
        {
          root: { type: 'leaf', leafId: leafIdFor(index) },
          activeLeafId: leafIdFor(index),
          expandedLeafId: null
        }
      ])
    ),
    paneForegroundAgentByPaneKey: {}
  })
  return tabs
}

function setProcessReadAgent(tabIndex: number): void {
  const state = useAppStore.getState() as {
    paneForegroundAgentByPaneKey: Record<string, unknown>
  }
  useAppStore.setState({
    paneForegroundAgentByPaneKey: {
      ...state.paneForegroundAgentByPaneKey,
      [`tab-${tabIndex}:${leafIdFor(tabIndex)}`]: {
        agent: 'claude',
        agentEvidence: 'process-read',
        shellForeground: false
      }
    }
  })
}

it('reruns the activity heuristic only for the tab whose pane foreground changed', () => {
  const tabs = seedTabs(TAB_COUNT)
  const { result } = renderHook(() => tabs.map((tab) => useTerminalTabActivity(tab)))
  expect(result.current.every((activity) => activity.activityStatus === 'active')).toBe(true)

  const heuristic = vi.mocked(resolveWorktreeStatus)
  heuristic.mockClear()
  act(() => setProcessReadAgent(0))

  expect(heuristic).toHaveBeenCalledTimes(1)
  // Control: the attributed tab spins; the other tabs keep their cached answer.
  expect(result.current[0].activityStatus).toBe('working')
  expect(result.current.slice(1).every((activity) => activity.activityStatus === 'active')).toBe(
    true
  )

  heuristic.mockClear()
  act(() => setProcessReadAgent(1))
  expect(heuristic).toHaveBeenCalledTimes(1)
  expect(result.current[1].activityStatus).toBe('working')
})
