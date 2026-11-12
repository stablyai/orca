import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup/workspace-cleanup'
import type {
  WorkspaceCleanupRemoveOptions,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { useWorkspaceCleanupRemoval } from './use-workspace-cleanup-removal'
import { useWorkspaceCleanupDialogLifecycle } from './use-workspace-cleanup-dialog-lifecycle'

const initialState = useAppStore.getInitialState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function worktreeId(name: string): string {
  return `repo-1::/repo/${name}`
}

function candidateFor(name: string, blockers: WorkspaceCleanupCandidate['blockers'] = []) {
  return makeCandidate({
    worktreeId: worktreeId(name),
    executionHostId: 'local',
    displayName: name,
    branch: name,
    path: `/repo/${name}`,
    blockers
  })
}

function startAgent(name: string): void {
  const paneKey = makePaneKey(`tab-${name}`, LEAF_ID)
  const updatedAt = Date.now()
  const entry: AgentStatusEntry = {
    paneKey,
    state: 'working',
    connectionId: null,
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: []
  }
  useAppStore.setState((state) => ({
    tabsByWorktree: {
      ...state.tabsByWorktree,
      [worktreeId(name)]: [makeTab({ id: `tab-${name}`, worktreeId: worktreeId(name) })]
    },
    agentStatusByPaneKey: acceptedAgentStatuses([
      ...state.agentStatusByPaneKey,
      [paneKey, entry] as const
    ])
  }))
}

type RemoveCall = { ids: readonly string[]; options: WorkspaceCleanupRemoveOptions | undefined }

function installRemoval(): RemoveCall[] {
  const calls: RemoveCall[] = []
  useAppStore.setState({
    removeWorkspaceCleanupCandidates: vi.fn(
      async (ids: readonly string[], options?: WorkspaceCleanupRemoveOptions) => {
        calls.push({ ids, options })
        return {
          removedIds: [],
          removedIdentities: [],
          failures: []
        } satisfies WorkspaceCleanupRemoveResult
      }
    )
  })
  return calls
}

function renderAtConfirm(candidates: WorkspaceCleanupCandidate[]) {
  const rendered = renderHook(() =>
    useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
  )
  act(() => rendered.result.current.openConfirmRemove(candidates))
  return rendered
}

describe('workspace cleanup removal of workspaces with a running agent', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    Object.assign(window, { api: { workspaceCleanup: {} } })
  })

  it('asks before stopping an agent and deletes nothing until the user confirms', async () => {
    const calls = installRemoval()
    startAgent('b')
    const { result } = renderAtConfirm([candidateFor('a'), candidateFor('b')])

    act(() => result.current.confirmRemove())

    expect(result.current.agentStopRequest?.candidates.map((c) => c.displayName)).toEqual(['b'])
    expect(result.current.removalInFlight).toBe(false)
    expect(useAppStore.getState().deleteStateByWorktreeId).toEqual({})

    act(() => result.current.cancelStopAgents())
    expect(result.current.agentStopRequest).toBeNull()
    expect(result.current.confirming).toBe(true)
    expect(calls).toEqual([])
  })

  it('re-asks when another agent starts while the stop step is open', () => {
    const calls = installRemoval()
    startAgent('b')
    const { result } = renderAtConfirm([candidateFor('a'), candidateFor('b')])
    act(() => result.current.confirmRemove())

    startAgent('a')
    act(() => result.current.confirmStopAgents())

    expect(result.current.agentStopRequest?.candidates.map((c) => c.displayName)).toEqual([
      'a',
      'b'
    ])
    expect(result.current.removalInFlight).toBe(false)
    expect(calls).toEqual([])
  })

  it('asks before stopping a structured chat that has no terminal tab', () => {
    const calls = installRemoval()
    const updatedAt = Date.now()
    const chatPaneKey = makePaneKey('chat-a', LEAF_ID)
    useAppStore.setState({
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [chatPaneKey]: {
            paneKey: chatPaneKey,
            worktreeId: worktreeId('a'),
            state: 'working',
            connectionId: null,
            prompt: '',
            updatedAt,
            stateStartedAt: updatedAt,
            stateHistory: []
          }
        })
      )
    })
    const { result } = renderAtConfirm([candidateFor('a')])

    act(() => result.current.confirmRemove())

    expect(result.current.agentStopRequest?.candidates.map((c) => c.displayName)).toEqual(['a'])
    expect(calls).toEqual([])
  })

  it('drops an open stop step when the dialog is reopened mid-batch', async () => {
    useAppStore.setState({
      scanWorkspaceCleanup: vi.fn(() => new Promise<never>(() => {})),
      hydrateWorkspaceCleanupFromCache: vi.fn(async () => false),
      hydrateWorkspaceSpaceFromCache: vi.fn(async () => false),
      removeWorkspaceCleanupCandidates: vi.fn(() => new Promise<never>(() => {}))
    })
    startAgent('b')
    const { result } = renderHook(() => useWorkspaceCleanupDialogLifecycle())
    act(() => useAppStore.getState().openModal('workspace-cleanup'))
    act(() => result.current.removal.openConfirmRemove([candidateFor('a')]))
    act(() => result.current.removal.confirmRemove())
    expect(result.current.removal.removalInFlight).toBe(true)

    act(() => result.current.removal.confirmUnverifiedRemoval(candidateFor('b')))
    expect(result.current.removal.agentStopRequest).not.toBeNull()

    act(() => useAppStore.getState().closeModal())
    act(() => useAppStore.getState().openModal('workspace-cleanup'))

    expect(result.current.removal.agentStopRequest).toBeNull()
    expect(result.current.removal.removalInFlight).toBe(true)
  })
})
