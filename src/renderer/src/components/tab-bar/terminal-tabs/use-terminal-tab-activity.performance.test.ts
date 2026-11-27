// @vitest-environment happy-dom
// Guards #15776: a process-read foreground change in one pane reruns the activity heuristic for
// that pane's tab only, not for every mounted terminal tab.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { resolveWorktreeStatus } from '@/lib/workspace/activity/worktree-status'
import type { PaneForegroundAgentEntry } from '@/store/slices/agent-status/pane-authority/pane-foreground-agent'
import { useTerminalTabActivity } from './use-terminal-tab-activity'

// Only the slices the hook reads; a loose test store keeps the fixture free of full AppState shapes.
const { testStore } = await vi.hoisted(async () => {
  const { create } = await import('zustand')
  return { testStore: create<Record<string, unknown>>(() => ({})) }
})
vi.mock('../../../store/index', () => ({ useAppStore: testStore }))
vi.mock('@/lib/workspace/activity/worktree-status', async (importOriginal) => {
  const actual = await importOriginal<{ resolveWorktreeStatus: typeof resolveWorktreeStatus }>()
  return { ...actual, resolveWorktreeStatus: vi.fn(actual.resolveWorktreeStatus) }
})

afterEach(cleanup)

const TAB_COUNT = 200
// A hand-started agent's providerless spinner title; only process-read evidence attributes it.
const SPINNER_TITLE = '◐ Install cursor plugins'
let foreground: Record<string, PaneForegroundAgentEntry> = {}

function leafIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function seedTabs(count: number): { id: string; title: string }[] {
  const tabs = Array.from({ length: count }, (_, index) => ({
    id: `tab-${index}`,
    title: SPINNER_TITLE
  }))
  foreground = {}
  testStore.setState({
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
    paneForegroundAgentByPaneKey: foreground
  })
  return tabs
}

function setProcessReadAgent(tabIndex: number): void {
  // A new map identity per write, keeping untouched entries, as the store slice does.
  foreground = {
    ...foreground,
    [`tab-${tabIndex}:${leafIdFor(tabIndex)}`]: {
      agent: 'claude',
      agentEvidence: 'process-read',
      shellForeground: false
    }
  }
  testStore.setState({ paneForegroundAgentByPaneKey: foreground })
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
