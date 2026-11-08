// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { buildAgentStatusScaleFixture } from '@/store/slices/agent-status/agent-status-scale.test-fixture'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

// One permission transition changes one card; sidebar sizing changes no status output.
describe('sidebar activity status subscription contract', () => {
  it.each([40, 400])('isolates a status transition among %i cards', (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000_000)
    const fixture = buildAgentStatusScaleFixture(undefined, count)
    useAppStore.setState(initialState, true)
    useAppStore.setState({
      ...fixture.state,
      agentStatusByPaneKey: fixture.agentStatusByPaneKey,
      refreshGitHubForWorktreeIfStale: vi.fn().mockResolvedValue(undefined)
    })
    const ids = Object.keys(fixture.state.tabsByWorktree)
    let commits = 0
    let picker: ReturnType<typeof useWorktreeActivityStatuses> | undefined
    const statuses = new Map<string, string>()
    function Probe({ worktreeId }: { worktreeId: string }) {
      const status = useWorktreeActivityStatus(worktreeId)
      useEffect(() => {
        commits += 1
        statuses.set(worktreeId, status)
      })
      return null
    }
    function Picker() {
      picker = useWorktreeActivityStatuses(ids)
      return null
    }
    render(
      <>
        <Picker />
        {ids.map((id) => (
          <Probe key={id} worktreeId={id} />
        ))}
      </>
    )
    commits = 0
    const index = fixture.owners.findIndex((owner) => owner.worktreeId === 'wt-17')
    act(() =>
      useAppStore
        .getState()
        .setAgentStatus(
          fixture.paneKeys[index],
          { state: 'blocked', agentType: 'claude', prompt: 'permission requested' },
          undefined,
          { updatedAt: 2_000_000_001 },
          fixture.owners[index]
        )
    )
    expect(commits).toBe(1)
    expect(statuses.get('wt-17')).toBe('permission')
    expect(picker?.get('wt-17')).toBe('permission')
    const previousPicker = picker
    commits = 0
    act(() => useAppStore.setState({ sidebarWidth: 333 }))
    expect(commits).toBe(0)
    expect(picker).toBe(previousPicker)
  })
})
