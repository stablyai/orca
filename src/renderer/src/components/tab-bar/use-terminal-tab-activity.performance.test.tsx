// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  makeAgentEntry,
  makeManyTabState
} from '../worktree-jump/worktree-jump-palette-test-fixtures'
import { useTerminalTabActivity } from './use-terminal-tab-activity'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

// Only the completed tab's glyph changes; other workspaces' titles and sidebar sizing change none.
describe('terminal tab activity subscription contract', () => {
  it.each([20, 200])('isolates one completion among %i tabs', (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000_000)
    useAppStore.setState(initialState, true)
    useAppStore.setState(makeManyTabState(count))
    const tabs = useAppStore.getState().tabsByWorktree['wt-many']
    const entries = tabs.map((tab) =>
      makeAgentEntry(tab.id, 'working', 2_000_000_000, { agentType: 'claude' })
    )
    useAppStore.setState({
      refreshGitHubForWorktreeIfStale: vi.fn().mockResolvedValue(undefined),
      agentStatusByPaneKey: Object.fromEntries(entries.map((entry) => [entry.paneKey, entry]))
    })
    let commits = 0
    const statuses = new Map<string, string>()
    function Probe({ tab }: { tab: (typeof tabs)[number] }) {
      const activity = useTerminalTabActivity(tab)
      useEffect(() => {
        commits += 1
        statuses.set(tab.id, activity.activityStatus)
      })
      return null
    }
    render(
      <>
        {tabs.map((tab) => (
          <Probe key={tab.id} tab={tab} />
        ))}
      </>
    )
    commits = 0
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          entries[5].paneKey,
          { state: 'done', agentType: 'claude', prompt: '' },
          undefined,
          { updatedAt: 2_000_000_001 },
          { tabId: tabs[5].id, worktreeId: 'wt-many' }
        )
    )
    expect(commits).toBe(1)
    expect(statuses.get('term-5')).toBe('done')
    commits = 0
    for (let tick = 0; tick < 20; tick += 1) {
      act(() =>
        useAppStore.setState({
          runtimePaneTitlesByTabId: { 'other-worktree-tab': { 0: `title ${tick}` } },
          sidebarWidth: 300 + tick
        })
      )
      expect(commits).toBe(0)
    }
  })
})
