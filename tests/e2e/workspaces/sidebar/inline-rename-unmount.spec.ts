import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from '../../desktop/renderer-probes/store'

const FILLER_WORKSPACE_COUNT = 100

test.beforeEach(async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1440, height: 900 })
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
})

// The sidebar list is virtualized, so scrolling an edited row away unmounts its focused input without a blur.
test('a workspace rename scrolled out of the sidebar list is saved', async ({ orcaPage }) => {
  await orcaPage.evaluate((count) => {
    const store = window.__store!
    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Expected a seeded e2e repo')
    }
    const seeded = state.worktreesByRepo[repo.id] ?? []
    const filler = Array.from({ length: count }, (_, index) => ({
      id: `${repo.id}::/rename-filler-${index}`,
      instanceId: `rename-filler-${index}`,
      repoId: repo.id,
      path: `${repo.path}/../rename-filler-${index}`,
      displayName: `Rename filler ${index}`,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: index,
      manualOrder: index,
      lastActivityAt: 0,
      head: '0000000000000000000000000000000000000000',
      branch: `rename-filler-${index}`,
      isBare: false,
      isMainWorktree: false
    }))
    state.setSidebarOpen(true)
    state.setShowSleepingWorkspaces(true)
    state.setFilterRepoIds([])
    store.setState({
      worktreesByRepo: { ...state.worktreesByRepo, [repo.id]: [...seeded, ...filler] }
    })
  }, FILLER_WORKSPACE_COUNT)

  const sidebar = orcaPage.locator('#workspace-list-region')
  const list = sidebar.locator('[data-worktree-sidebar]')
  const title = sidebar.getByText('e2e-secondary', { exact: true }).first()
  await title.scrollIntoViewIfNeeded()
  const titleTop = await title.evaluate((el) => el.getBoundingClientRect().top)
  await title.dblclick()
  const input = orcaPage.getByRole('textbox', { name: 'Rename workspace' })
  await expect(input).toBeFocused()
  await input.fill('renamed-then-scrolled')

  // Scroll to whichever end is farther from the edited row.
  const listBox = await list.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    return { top: rect.top, height: rect.height, scrollHeight: el.scrollHeight }
  })
  const toBottom = titleTop - listBox.top < listBox.height / 2
  await list.evaluate((el, bottom) => {
    el.scrollTop = bottom ? el.scrollHeight : 0
  }, toBottom)
  await expect(input).toHaveCount(0)
  await list.evaluate((el, bottom) => {
    el.scrollTop = bottom ? 0 : el.scrollHeight
  }, toBottom)
  await expect(sidebar.getByText('renamed-then-scrolled', { exact: true })).toBeVisible()
})
