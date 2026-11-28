import { beforeAll, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { dashboardPreviewHttpActions } from './dashboard-preview-http-actions'

vi.mock('sonner', () => ({
  toast: { loading: vi.fn(() => 'toast'), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/store/index', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

const WORKSPACE = 'repo1::/repo'
const PR_URL = 'https://github.com/acme/web/pull/21'
const card = {
  worktreeId: WORKSPACE,
  executionHostId: 'local',
  tabId: 'source',
  ptyId: 'pty-1'
} as const

const workItemByOwnerRepo = vi.fn()
const openTaskPage = vi.fn()

function seed(store: typeof useAppStore): void {
  seedStore(store, {
    openTaskPage,
    repos: [{ id: 'repo1', path: '/repo', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKSPACE, repoId: 'repo1', path: '/repo', hostId: 'local' })]
    },
    activeWorktreeId: WORKSPACE,
    activeWorkspaceExecutionHostId: 'local'
  })
}

beforeAll(() => {
  Object.assign(globalThis, { window: { api: { gh: { workItemByOwnerRepo } } } })
  seed(useAppStore)
})

it('T5a: a card that cannot open the managed browser still offers to open its PR in Orca', () => {
  const actions = dashboardPreviewHttpActions(card, PR_URL)

  expect(actions?.canOpen).toBe(false)
  expect(actions?.alternate).toBeUndefined()
  expect(actions?.secondaryActions?.map((action) => action.icon)).toEqual(['open-in-orca'])
})

it('closes the dashboard dialog and drawer only once the PR page has opened', async () => {
  const onForegroundOpen = vi.fn()
  const openInOrca = () =>
    dashboardPreviewHttpActions(card, PR_URL, onForegroundOpen)?.secondaryActions?.find(
      (action) => action.icon === 'open-in-orca'
    )

  workItemByOwnerRepo.mockResolvedValueOnce(null)
  await openInOrca()?.run()
  expect(openTaskPage).not.toHaveBeenCalled()
  expect(onForegroundOpen).not.toHaveBeenCalled()

  workItemByOwnerRepo.mockResolvedValueOnce({
    id: 'pr:21',
    type: 'pr',
    number: 21,
    title: 'Item',
    state: 'open',
    url: PR_URL,
    labels: [],
    updatedAt: '2026-11-20T00:00:00Z',
    author: null
  })
  await openInOrca()?.run()
  expect(openTaskPage).toHaveBeenCalledTimes(1)
  expect(onForegroundOpen).toHaveBeenCalledTimes(1)
})

it('T5b: the dashboard pop-out never offers it', async () => {
  // The gate is permanent for a window, so it runs on fresh module copies that no other test shares.
  vi.resetModules()
  seed((await import('@/store/index')).useAppStore)
  const { disableTaskPageLinkActions } =
    await import('@/lib/work-items/github/github-link-task-target')
  const fresh = (await import('./dashboard-preview-http-actions')).dashboardPreviewHttpActions
  const icons = () => fresh(card, PR_URL)?.secondaryActions?.map((action) => action.icon)
  expect(icons()).toEqual(['open-in-orca'])

  disableTaskPageLinkActions()

  expect(icons()).toBeUndefined()
})
