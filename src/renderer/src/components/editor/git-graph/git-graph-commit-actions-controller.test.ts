import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
// @vitest-environment happy-dom
import * as commitSupport from '@/runtime/git-commit-actions-capability'
import * as commitActions from '@/runtime/runtime-git-commit-actions-client'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { gitGraphHistoryForTab, disposeGitGraphHistory } from './git-graph-tab-controllers'
import { workspaceId, local, repo } from './git-graph-workspace.test-fixtures'
import type { GitHistoryResult } from '../../../../../shared/git/history/git-history-types'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }))
vi.mock('@/runtime/runtime-git-status-client', async (original) => ({
  ...(await original<object>()),
  getRuntimeGitHistory: getHistory
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
    gitGraphFiltersByWorktree: {}
  })
  getHistory.mockReset().mockResolvedValue(result)
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
