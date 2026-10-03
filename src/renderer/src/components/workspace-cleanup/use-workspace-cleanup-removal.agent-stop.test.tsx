// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import type {
  WorkspaceCleanupRemoveOptions,
  WorkspaceCleanupRemoveResult
} from '@/store/slices/workspace-cleanup-removal'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))

import { useAppStore } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
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
    agentStatusByPaneKey: { ...state.agentStatusByPaneKey, [paneKey]: entry }
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

function approvedBlockersById(calls: readonly RemoveCall[]): Record<string, string[]> {
  return Object.fromEntries(
    calls.flatMap((call) =>
      (call.options?.approvedCandidates ?? []).map((candidate) => [
        candidate.worktreeId,
        candidate.blockers
      ])
    )
  )
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

  it('deletes with the agent stop recorded only on the rows the user approved', async () => {
    const calls = installRemoval()
    startAgent('b')
    // A stale scan label must not count as the user's approval.
    const { result } = renderAtConfirm([candidateFor('a', ['live-agent']), candidateFor('b')])

    act(() => result.current.confirmRemove())
    act(() => result.current.confirmStopAgents())

    expect(result.current.agentStopRequest).toBeNull()
    await waitFor(() => expect(calls).toHaveLength(2))
    const blockers = approvedBlockersById(calls)
    expect(blockers[worktreeId('a')]).not.toContain('live-agent')
    expect(blockers[worktreeId('b')]).toContain('live-agent')
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
      agentStatusByPaneKey: {
        [chatPaneKey]: {
          paneKey: chatPaneKey,
          worktreeId: worktreeId('a'),
          state: 'working',
          prompt: '',
          updatedAt,
          stateStartedAt: updatedAt,
          stateHistory: []
        }
      }
    })
    const { result } = renderAtConfirm([candidateFor('a')])

    act(() => result.current.confirmRemove())

    expect(result.current.agentStopRequest?.candidates.map((c) => c.displayName)).toEqual(['a'])
    expect(calls).toEqual([])
  })

  it('adds no step when no agent is running', async () => {
    const calls = installRemoval()
    const { result } = renderAtConfirm([candidateFor('a')])

    act(() => result.current.confirmRemove())

    expect(result.current.agentStopRequest).toBeNull()
    await waitFor(() => expect(calls).toHaveLength(1))
  })

  it('asks before "Delete anyway" stops a running agent', async () => {
    const calls = installRemoval()
    startAgent('b')
    const { result } = renderHook(() =>
      useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
    )

    act(() => result.current.confirmUnverifiedRemoval(candidateFor('b')))
    expect(result.current.agentStopRequest?.unverifiedCandidate?.displayName).toBe('b')
    expect(calls).toEqual([])

    act(() => result.current.confirmStopAgents())
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].options?.unverifiedRemovalConsent).toBeDefined()
    expect(approvedBlockersById(calls)[worktreeId('b')]).toContain('live-agent')
  })

  it('drops an open stop step when the dialog is reopened mid-batch', async () => {
    useAppStore.setState({
      scanWorkspaceCleanup: vi.fn(() => new Promise<never>(() => {})),
      hydrateWorkspaceCleanupFromCache: vi.fn(async () => false),
      hydrateWorkspaceSpaceFromCache: vi.fn(async () => false),
      // The batch never settles, so it stays in flight across close and reopen.
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
