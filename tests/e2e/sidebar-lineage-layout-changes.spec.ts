import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  seedOrdinaryRowsAboveLineage,
  seedVirtualLineage
} from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'
import { seedWorkspaceAgentStatus } from './worktree-lineage-state'

test('mounting an offscreen lineage preserves the shared scroll position', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await expect(worktreeRow(orcaPage, 'ordinary-0')).toBeInViewport()
  await orcaPage.waitForTimeout(650)
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, bubbles: true }))
    element.scrollTop = 25_000
  })
  await orcaPage.waitForTimeout(650)
  expect(await scroller.evaluate((element) => Math.abs(element.scrollTop - 25_000))).toBeLessThan(2)
  await expect(orcaPage.locator('[data-lineage-virtual-item]').first()).toBeAttached()
})

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

test('remounted measured descendants grow below the fold without shifting the reading anchor', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await orcaPage.waitForTimeout(650)
  const targetId = 'e2e-virtual-child-200'
  const target = worktreeRow(orcaPage, targetId)
  const reveal = () =>
    orcaPage.evaluate((id) => {
      window.__store!.getState().revealWorktreeInSidebar(id, { behavior: 'auto' })
    }, targetId)
  await reveal()
  await expect(target).toBeInViewport()
  await orcaPage.waitForTimeout(700)
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  await scroller.evaluate((element) => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }))
    element.scrollTop = 0
  })
  await expect(orcaPage.locator('[data-lineage-virtual-children]')).toHaveCount(0)
  await orcaPage.waitForTimeout(700)
  await reveal()
  await expect(target).toBeInViewport()
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }))
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 20
  })
  await orcaPage.waitForTimeout(700)
  const geometry = () =>
    target.evaluate((element) => {
      const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
      const bounds = element.getBoundingClientRect()
      return {
        top: bounds.top - scroller.getBoundingClientRect().top,
        height: bounds.height,
        scrollTop: scroller.scrollTop
      }
    })
  const before = await geometry()
  expect(Math.abs(before.top + 20)).toBeLessThan(2)
  expect(before.top + before.height).toBeGreaterThan(0)
  await seedWorkspaceAgentStatus(orcaPage, targetId, 'REMOUNT_SPANNING_GROWTH')
  await expect.poll(async () => (await geometry()).height).toBeGreaterThan(before.height + 10)
  await orcaPage.waitForTimeout(700)
  const after = await geometry()
  await writeFile(
    testInfo.outputPath('remounted-spanning-growth.json'),
    JSON.stringify({ before, after, drift: after.top - before.top }, null, 2)
  )
  expect(Math.abs(after.top - before.top)).toBeLessThan(2)
  expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThan(2)
  await scroller.screenshot({ path: testInfo.outputPath('remounted-spanning-growth.png') })
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
    // Pending preference snapshots must not restore the previous card layout.
    window.__store!.getState().setWorktreeCardProperties(['status'])
    window.__store!.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, experimentalNewWorktreeCardStyle: true }
        : null
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

test('smooth reveal lands while background agent status updates continue', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { targetId, parentId } = await seedVirtualLineage(orcaPage, false)
  await seedWorkspaceAgentStatus(orcaPage, parentId, 'REVEAL_CHURN')
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  const updates = await orcaPage.evaluate(
    async ({ targetId, parentId }) => {
      const state = window.__store!.getState()
      const tab = state.tabsByWorktree[parentId]![0]!
      state.revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: true })
      let updates = 0
      const started = performance.now()
      while (performance.now() - started < 1_800) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        state.setAgentStatus(
          `${tab.id}:reveal-churn`,
          {
            state: updates % 2 === 0 ? 'working' : 'waiting',
            prompt: `Background update ${updates++}`,
            agentType: 'codex'
          },
          'codex',
          { updatedAt: Date.now(), stateStartedAt: Date.now() }
        )
      }
      return updates
    },
    { targetId, parentId }
  )
  expect(updates).toBeGreaterThan(10)
  const target = worktreeRow(orcaPage, targetId)
  await expect(target.getByText('Virtual child 400', { exact: true })).toBeInViewport()
  await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
})
