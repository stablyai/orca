import * as branchActions from '@/runtime/source-control/git/runtime-git-branch-client'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
// @vitest-environment happy-dom
import * as commitSupport from '@/runtime/source-control/git/git-commit-actions-capability'
import * as commitActions from '@/runtime/source-control/git/runtime-git-commit-actions-client'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'
import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const { getHistory, getStatus } = vi.hoisted(() => ({
  getHistory: vi.fn(),
  getStatus: vi.fn()
}))
vi.mock('@/runtime/source-control/git/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory,
  getRuntimeGitStatus: getStatus
}))
const initial = useAppStore.getState()
const result: GitHistoryResult = {
  items: [
    { id: 'a', subject: 'source', message: 'source', parentIds: [] },
    { id: 'b', subject: 'newer selection', message: 'newer selection', parentIds: [] }
  ],
  hasMore: false,
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  limit: 50
}
let detach: (() => void) | undefined
beforeEach(() => {
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: { r: [local] },
    activeWorktreeId: workspaceId,
    activeWorkspaceExecutionHostId: 'local',
    gitGraphFiltersByWorktree: {},
    gitConflictOperationByWorktree: {}
  })
  getHistory.mockReset().mockResolvedValue(result)
  getStatus.mockReset().mockResolvedValue({
    entries: [],
    conflictOperation: 'unknown',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  })
  vi.spyOn(commitSupport, 'gitCommitActionsSupported').mockResolvedValue(true)
})
afterEach(() => {
  detach?.()
  disposeGitGraphHistory(`${workspaceId}::git-graph`)
  useAppStore.setState(initial, true)
  vi.restoreAllMocks()
})

it('refreshes and announces a landed action after navigation without replacing the newer selection', async () => {
  const controller = gitGraphHistoryForTab(workspaceId)
  detach = controller.attach()
  await controller.settledResult()
  const completion = Promise.withResolvers<{
    outcome: 'landed'
    commitId: string
    branch: string
  }>()
  const started = Promise.withResolvers<void>()
  vi.spyOn(commitActions, 'cherryPickRuntimeGit').mockImplementation(() => {
    started.resolve()
    return completion.promise
  })
  const announce = vi.spyOn(toast, 'message')
  controller.actions.request('cherry-pick', result.items[0]!)
  const applying = controller.actions.confirm()
  await started.promise
  controller.select('b')
  getHistory.mockResolvedValue({
    ...result,
    items: [
      ...result.items,
      { id: 'ccccccc', subject: 'created', message: 'created', parentIds: [] }
    ]
  })
  completion.resolve({ outcome: 'landed', commitId: 'ccccccc', branch: 'main' })
  await applying
  expect(announce).toHaveBeenCalled()
  expect(controller.view.getState().selectedId).toBe('b')
  expect(controller.view.getState().result?.items.map((item) => item.id)).toEqual([
    'a',
    'b',
    'ccccccc'
  ])
})

it('selects the created commit through the filter reload when showing all branches', async () => {
  useAppStore.setState({ gitGraphFiltersByWorktree: { [workspaceId]: 'head' } })
  const controller = gitGraphHistoryForTab(workspaceId)
  detach = controller.attach()
  await controller.settledResult()
  vi.spyOn(commitActions, 'cherryPickRuntimeGit').mockResolvedValue({
    outcome: 'landed',
    commitId: 'ccccccc',
    branch: 'main'
  })
  const announce = vi.spyOn(toast, 'message')
  controller.actions.request('cherry-pick', result.items[0]!)
  await controller.actions.confirm()
  const action = announce.mock.calls.at(-1)?.[1]?.action
  if (!action || typeof action !== 'object' || !('onClick' in action)) {
    throw new Error('Expected the outcome to offer all branches')
  }
  getHistory.mockResolvedValue({
    ...result,
    items: [
      ...result.items,
      { id: 'ccccccc', subject: 'created', message: 'created', parentIds: [] }
    ]
  })
  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => root.render(createElement('button', { onClick: action.onClick })))
  await act(async () => {
    container.querySelector('button')!.click()
    await controller.settledResult()
  })
  await act(async () => root.unmount())
  expect(useAppStore.getState().gitGraphFiltersByWorktree?.[workspaceId]).toBe('all')
  expect(controller.view.getState().selectedId).toBe('ccccccc')
})

it.each([
  ['refs/heads/feature', 'local', 'feature'],
  ['refs/remotes/origin/topic', 'remote', 'origin/topic']
] as const)(
  'checks out %s through the shared branch switch and reports its landed warning',
  async (id, kind, name) => {
    const controller = gitGraphHistoryForTab(workspaceId)
    detach = controller.attach()
    await controller.settledResult()
    const switching = vi.spyOn(branchActions, 'switchRuntimeGitBranch').mockResolvedValue({
      ok: true,
      branch: 'my-topic',
      head: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      warning:
        "Error invoking remote method 'git:switchBranch': Error: Tracking configured; hook failed."
    })
    getHistory.mockResolvedValue({
      ...result,
      items: [
        ...result.items,
        {
          id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          subject: 'advanced tracker',
          message: 'advanced tracker',
          parentIds: []
        }
      ]
    })
    const announce = vi.spyOn(toast, 'message')
    controller.actions.requestBranch(result.items[0]!, { id, name })
    await controller.actions.confirm()
    expect(switching).toHaveBeenCalledWith(
      {
        target: { kind: 'local' },
        worktreeId: workspaceId,
        worktreePath: local.path,
        connectionId: undefined
      },
      { kind, name },
      undefined,
      expect.any(Function)
    )
    expect(controller.view.getState().selectedId).toBe('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
    expect(announce.mock.calls.at(-1)?.[1]?.description).toBe(
      'Now at bbbbbbb on my-topic\nTracking configured; hook failed.'
    )
  }
)

it('shows refreshed conflict status by the time the action outcome is announced', async () => {
  const controller = gitGraphHistoryForTab(workspaceId)
  detach = controller.attach()
  await controller.settledResult()
  vi.spyOn(commitActions, 'cherryPickRuntimeGit').mockResolvedValue({ outcome: 'conflicted' })
  getStatus.mockResolvedValue({
    entries: [],
    conflictOperation: 'cherry-pick',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  })
  let operationAtAnnouncement: string | undefined
  vi.spyOn(toast, 'message').mockImplementation(() => {
    operationAtAnnouncement = useAppStore.getState().gitConflictOperationByWorktree[workspaceId]
    return 'outcome'
  })
  controller.actions.request('cherry-pick', result.items[0]!)
  await controller.actions.confirm()
  expect(operationAtAnnouncement).toBe('cherry-pick')
})

it('shows a local create-branch refusal without the IPC wrapper', async () => {
  const controller = gitGraphHistoryForTab(workspaceId)
  detach = controller.attach()
  await controller.settledResult()
  vi.spyOn(commitActions, 'createRuntimeGitBranch').mockRejectedValue(
    new Error(
      "Error invoking remote method 'git:createBranch': Error: A local branch named topic already exists. Switch to that branch instead."
    )
  )
  const announce = vi.spyOn(toast, 'message')
  controller.actions.request('create-branch', result.items[0]!)
  controller.actions.setBranchName('topic')
  await controller.actions.confirm()
  expect(announce.mock.calls.at(-1)?.[1]?.description).toBe(
    'A local branch named topic already exists. Switch to that branch instead.'
  )
})
