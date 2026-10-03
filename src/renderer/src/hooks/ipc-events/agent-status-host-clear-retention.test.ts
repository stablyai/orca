// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetAgentPaneAuthorityAliasesForTests } from '@/store/slices/agent-pane-authority'
import { useRetainedAgentsSync } from '@/components/dashboard/useRetainedAgents'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { registerAgentStatusListeners } from './agent-status-listeners'

// The host clears a pane only when its agent ended or the pane went away. A Done agent that quit
// is not waiting on the user, so the clear must not turn into a retained Done in the sidebar or
// dashboard while `worktree ps` and mobile show nothing.

const initialAppState = useAppStore.getInitialState()
const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}
const worktree: Worktree = {
  id: 'wt-1',
  repoId: 'repo-1',
  path: '/repo/wt-1',
  head: 'abc123',
  branch: 'feature',
  isBare: false,
  isMainWorktree: false,
  displayName: 'feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

const doneEntry: AgentStatusEntry = {
  state: 'done',
  prompt: 'Fix it',
  updatedAt: Date.now(),
  stateStartedAt: Date.now(),
  paneKey: PANE_KEY,
  terminalTitle: 'Claude',
  stateHistory: [],
  agentType: 'claude'
}

let hostClear: (data: AgentStatusClearIpcPayload) => void = () => {}
const drop = vi.fn()

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  resetAgentPaneAuthorityAliasesForTests()
  vi.stubGlobal('api', {
    agentStatus: {
      onSet: () => () => {},
      onClear: (callback: (data: AgentStatusClearIpcPayload) => void) => {
        hostClear = callback
        return () => {}
      },
      drop
    }
  })
  registerAgentStatusListeners({
    unsubs: [],
    enqueueLiveAgentStatus: () => {},
    drainQueuedLiveAgentStatusesForPane: () => {},
    pendingAgentStatusEvents: [],
    transientClearWatermarkByConnectionId: new Map(),
    liveAgentStatusBurstQueue: []
  })
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] },
    tabsByWorktree: {
      [worktree.id]: [
        {
          id: 'tab-1',
          worktreeId: worktree.id,
          title: 'Claude',
          ptyId: 'pty-1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    agentStatusByPaneKey: { [PANE_KEY]: doneEntry },
    agentStatusEpoch: initialAppState.agentStatusEpoch + 1
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  drop.mockReset()
  useAppStore.setState(initialAppState, true)
  resetAgentPaneAuthorityAliasesForTests()
})

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}

describe('a host pane clear of a Done agent', () => {
  it('removes the row everywhere and leaves no retained Done', async () => {
    renderHook(() => useRetainedAgentsSync())
    await flushEffects()

    act(() => hostClear({ paneKey: PANE_KEY }))
    await flushEffects()

    const state = useAppStore.getState()
    expect(state.agentStatusByPaneKey[PANE_KEY]).toBeUndefined()
    expect(state.retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
    // The host already removed its row; echoing a drop back would be a second removal.
    expect(drop).not.toHaveBeenCalled()
  })

  it('also drops a Done the retention list took before the clear arrived', async () => {
    renderHook(() => useRetainedAgentsSync())
    await flushEffects()
    // The renderer's own PTY-exit cleanup removed the row first; retention kept it.
    act(() => useAppStore.getState().removeAgentStatus(PANE_KEY))
    await flushEffects()
    expect(useAppStore.getState().retainedAgentsByPaneKey[PANE_KEY]?.entry.state).toBe('done')

    act(() => hostClear({ paneKey: PANE_KEY }))
    await flushEffects()

    expect(useAppStore.getState().retainedAgentsByPaneKey[PANE_KEY]).toBeUndefined()
  })
})
