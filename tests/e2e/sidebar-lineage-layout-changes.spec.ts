import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

test('restores the descendant title after switching sidebar bodies', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { targetId } = await seedVirtualLineage(orcaPage, false)
  await orcaPage.evaluate((targetId) => {
    window.__store!.getState().revealWorktreeInSidebar(targetId, { behavior: 'auto' })
  }, targetId)
  const title = worktreeRow(orcaPage, targetId).getByText('Virtual child 400', { exact: true })
  await expect(title).toBeInViewport()
  await orcaPage.waitForTimeout(650)
  const before = (await title.boundingBox())!.y
  await orcaPage.evaluate(() => window.__store!.getState().setSidebarBody('agents'))
  await expect(orcaPage.locator('[data-worktree-sidebar]')).toHaveCount(0)
  await orcaPage.evaluate(() => window.__store!.getState().setSidebarBody('workspaces'))
  await expect(title).toBeInViewport()
  await expect.poll(async () => Math.abs((await title.boundingBox())!.y - before)).toBeLessThan(2)
})

test('remeasures recycled descendants after card style and viewport changes', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { targetId, parentId } = await seedVirtualLineage(orcaPage, false)
  const reveal = async (id: string): Promise<void> => {
    await orcaPage.evaluate((id) => {
      window.__store!.getState().revealWorktreeInSidebar(id, { behavior: 'auto' })
    }, id)
  }
  await reveal(targetId)
  await expect(worktreeRow(orcaPage, targetId)).toBeInViewport()
  await reveal(parentId)
  await expect(worktreeRow(orcaPage, targetId)).toHaveCount(0)
  await orcaPage.setViewportSize({ width: 1_100, height: 800 })
  await orcaPage.evaluate(() => {
    window.__store!.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, experimentalNewWorktreeCardStyle: true }
        : null,
      worktreeCardProperties: ['status']
    }))
  })
  await reveal(targetId)
  await expect(
    worktreeRow(orcaPage, targetId).getByText('Virtual child 400', { exact: true })
  ).toBeInViewport()
  expect(await orcaPage.locator('[data-lineage-virtual-item]').count()).toBeLessThan(60)
})

test('releases coincident worktree and sidebar-row reveals after scrolling away', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { targetId } = await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  await orcaPage.evaluate((targetId) => {
    const state = window.__store!.getState()
    const first = document.querySelector<HTMLElement>('[data-worktree-id="e2e-virtual-child-0"]')!
    const rowKey = first.dataset.worktreeRowKey!.replace('e2e-virtual-child-0', targetId)
    state.revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: false })
    state.revealSidebarRow(rowKey, { behavior: 'smooth', highlight: false })
  }, targetId)
  const target = worktreeRow(orcaPage, targetId)
  await expect(target.getByText('Virtual child 400', { exact: true })).toBeInViewport()
  await orcaPage.waitForTimeout(1_200)
  await orcaPage.locator('[data-worktree-sidebar]').evaluate((element) => {
    element.scrollTo({ top: 0, behavior: 'instant' })
  })
  await expect(target).toHaveCount(0)
})
