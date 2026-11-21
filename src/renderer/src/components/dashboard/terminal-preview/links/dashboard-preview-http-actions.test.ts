import { beforeAll, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { WORKSPACE } from '@/lib/browser/navigation/browser-link-open.test-fixture'
import { disableTaskPageLinkActions } from '@/lib/work-items/github/github-link-task-target'
import { dashboardPreviewHttpActions } from './dashboard-preview-http-actions'

vi.mock('@/store/index', async () => {
  const { createBrowserLinkTestStore } =
    await import('@/lib/browser/navigation/browser-link-open.test-fixture')
  return { useAppStore: createBrowserLinkTestStore() }
})

const PR_URL = 'https://github.com/acme/web/pull/21'
const card = {
  worktreeId: WORKSPACE,
  executionHostId: 'local',
  tabId: 'source',
  ptyId: 'pty-1'
} as const

beforeAll(() => {
  useAppStore.setState({
    repos: [{ id: 'repo1', path: '/repo', displayName: 'Repo', badgeColor: '#000', addedAt: 0 }]
  })
})

it('T5a: a card that cannot open the managed browser still offers to open its PR in Orca', () => {
  const actions = dashboardPreviewHttpActions(card, PR_URL)

  expect(actions?.canOpen).toBe(false)
  expect(actions?.alternate).toBeUndefined()
  expect(actions?.secondaryActions?.map((action) => action.icon)).toEqual(['open-in-orca'])
})

// Last: the pop-out gate is permanent for the window, as it is in the pop-out renderer.
it('T5b: the dashboard pop-out never offers it', () => {
  disableTaskPageLinkActions()

  expect(dashboardPreviewHttpActions(card, PR_URL)?.secondaryActions).toBeUndefined()
})
