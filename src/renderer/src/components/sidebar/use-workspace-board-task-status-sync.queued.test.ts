// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linearGetIssue, linearUpdateIssue } from '@/runtime/runtime-linear-issue-mutations'
import { linearTeamStates } from '@/runtime/runtime-linear-project-client'
import type { LinearMutationResult } from '@/runtime/runtime-linear-client'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import type { WorkspaceRecordState } from '@/store/workspace-record-selectors'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import * as taskStatusSync from './workspace-board-task-status-sync'
import { useWorkspaceBoardTaskStatusSync } from './use-workspace-board-task-status-sync'

const { getState } = vi.hoisted(() => ({
  getState: vi.fn<() => WorktreeOperationRouteState & WorkspaceRecordState>()
}))

vi.mock('@/store', () => ({ useAppStore: { getState } }))
vi.mock('@/runtime/runtime-linear-issue-mutations', () => ({
  linearGetIssue: vi.fn(),
  linearUpdateIssue: vi.fn()
}))
vi.mock('@/runtime/runtime-linear-project-client', () => ({ linearTeamStates: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

const issue: LinearIssue = {
  id: 'issue-1',
  identifier: 'ORC-1',
  title: 'Sync the board',
  description: '',
  url: 'https://linear.app/orca/issue/ORC-1',
  state: { name: 'Todo', type: 'unstarted', color: '#999' },
  team: { id: 'team-1', name: 'Orca', key: 'ORC' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-06-15T00:00:00.000Z'
}
const statuses = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-review', label: 'In review' }
]

function setup(hostId: 'local' | 'runtime:env-b') {
  const card = makeWorktree({
    id: 'repo::/w',
    repoId: 'repo',
    hostId,
    workspaceStatus: 'todo',
    linkedLinearIssue: issue.identifier
  })
  const twin = { ...card, hostId: hostId === 'local' ? 'runtime:env-b' : 'local' } as const
  const catalog = (rows: (typeof card)[]) => {
    const state = {
      worktreesByRepo: { repo: rows },
      folderWorkspaces: [],
      detectedWorktreesByRepo: {},
      floatingWorkspacePath: null,
      getKnownWorktreeById: (id: string, hostId?: ExecutionHostId) =>
        findKnownWorktreeById(state, id, hostId)
    }
    return state
  }
  getState.mockReturnValue(catalog([{ ...card, workspaceStatus: 'in-review' }, twin]))
  const sync = vi.spyOn(taskStatusSync, 'syncWorkspaceBoardTaskStatuses')
  const { result } = renderHook(() =>
    useWorkspaceBoardTaskStatusSync({
      enabled: true,
      worktreesByKey: new Map([[getWorktreeHostIdentity(card), card]]),
      workspaceStatuses: statuses
    })
  )
  return {
    sync,
    move: () => result.current([getWorktreeHostIdentity(card)], 'in-review'),
    removeCard: () => {
      getState.mockReturnValue(catalog([{ ...twin, workspaceStatus: 'in-review' }]))
    },
    settings:
      hostId === 'local'
        ? { kind: 'local' as const }
        : { kind: 'environment' as const, environmentId: 'env-b' }
  }
}

beforeEach(() => {
  vi.mocked(linearGetIssue).mockResolvedValue(issue)
  vi.mocked(linearTeamStates).mockResolvedValue([
    { id: 'state-review', name: 'In review', type: 'started', color: '#111', position: 1 }
  ])
  vi.mocked(linearUpdateIssue).mockResolvedValue({ ok: true })
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe.each(['local', 'runtime:env-b'] as const)('queued task sync for %s', (hostId) => {
  it('refuses provider access when the captured copy disappears while queued', async () => {
    const { sync, move, removeCard, settings } = setup(hostId)
    const firstUpdate = Promise.withResolvers<LinearMutationResult>()
    vi.mocked(linearUpdateIssue).mockReturnValueOnce(firstUpdate.promise)

    move()
    await vi.waitFor(() => expect(linearUpdateIssue).toHaveBeenCalledTimes(1))
    move()
    expect(sync).toHaveBeenCalledTimes(2)
    expect(linearGetIssue).toHaveBeenCalledTimes(1)

    removeCard()
    firstUpdate.resolve({ ok: true })
    const results = await Promise.all(sync.mock.results.map((result) => result.value))

    expect(results).toEqual([
      { updated: 1, skipped: 0, failed: 0, messages: [] },
      {
        updated: 0,
        skipped: 1,
        failed: 0,
        messages: [{ kind: 'owner-ambiguous', issueIdentifier: issue.identifier }]
      }
    ])
    expect(linearGetIssue).toHaveBeenCalledExactlyOnceWith(settings, issue.identifier, undefined)
    expect(linearTeamStates).toHaveBeenCalledExactlyOnceWith(settings, 'team-1', undefined)
    expect(linearUpdateIssue).toHaveBeenCalledExactlyOnceWith(
      settings,
      issue.id,
      { stateId: 'state-review' },
      undefined
    )
  })

  it('does not borrow the surviving twin status when the captured copy disappears during a read', async () => {
    const { sync, move, removeCard, settings } = setup(hostId)
    const pendingIssue = Promise.withResolvers<LinearIssue | null>()
    vi.mocked(linearGetIssue).mockReturnValueOnce(pendingIssue.promise)

    move()
    await vi.waitFor(() => expect(linearGetIssue).toHaveBeenCalledTimes(1))
    removeCard()
    pendingIssue.resolve(issue)
    const results = await Promise.all(sync.mock.results.map((result) => result.value))

    expect(results).toEqual([{ updated: 0, skipped: 1, failed: 0, messages: [] }])
    expect(linearTeamStates).toHaveBeenCalledExactlyOnceWith(settings, 'team-1', undefined)
    expect(linearUpdateIssue).not.toHaveBeenCalled()
  })
})
