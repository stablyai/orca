// @vitest-environment happy-dom
import { useEffect } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { buildAgentStatusScaleFixture } from '@/store/slices/agent-status/agent-status-scale.test-fixture'
import { useWorktreeAgentRows } from './useWorktreeAgentRows'

const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

// Only the card owning the changed prompt has new rows; a same-freshness epoch changes none.
describe('worktree agent row subscription contract', () => {
  it.each([40, 400])('isolates a status ping among %i cards', (count) => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000_000)
    const fixture = buildAgentStatusScaleFixture(undefined, count)
    useAppStore.setState(initialState, true)
    useAppStore.setState({ ...fixture.state, agentStatusByPaneKey: fixture.agentStatusByPaneKey })
    let commits = 0
    const prompts = new Map<string, string>()
    function Probe({ worktreeId }: { worktreeId: string }) {
      const rows = useWorktreeAgentRows(worktreeId, true)
      useEffect(() => {
        commits += 1
        prompts.set(worktreeId, rows[0]?.entry.prompt ?? '')
      })
      return null
    }
    render(
      <>
        {Object.keys(fixture.state.tabsByWorktree).map((id) => (
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
          { state: 'working', agentType: 'claude', prompt: 'changed prompt' },
          undefined,
          { updatedAt: 2_000_000_001 },
          fixture.owners[index]
        )
    )
    expect(commits).toBe(1)
    expect(prompts.get('wt-17')).toBe('changed prompt')
    commits = 0
    act(() =>
      useAppStore.setState({ agentStatusEpoch: useAppStore.getState().agentStatusEpoch + 1 })
    )
    expect(commits).toBe(0)
  })
})
