import { writeFile } from 'node:fs/promises'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  seedOrdinaryRowsAboveLineage,
  seedVirtualLineage
} from './sidebar-lineage-virtualization-state'
import { seedWorkspaceAgentStatus } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

test('lineage descendants keep their anchor when an ordinary card above grows during suppression', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await orcaPage.waitForTimeout(650)
  await orcaPage.evaluate(() => {
    window
      .__store!.getState()
      .revealWorktreeInSidebar('e2e-virtual-child-200', { behavior: 'auto' })
  })
  const targetId = 'e2e-virtual-child-200'
  const target = worktreeRow(orcaPage, targetId)
  await expect(target).toBeAttached()
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, bubbles: true }))
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  })
  await orcaPage.waitForTimeout(650)
  await expect(target).toBeInViewport()
  const previousTop = (await target.boundingBox())!.y
  const above = worktreeRow(orcaPage, 'ordinary-79')
  const previousHeight = (await above.boundingBox())!.height
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  const before = await scroller.evaluate((element) => {
    element.dispatchEvent(new Event('orca-record-virtualized-scroll-anchor'))
    element.dispatchEvent(new Event('scroll'))
    const group = element.querySelector<HTMLElement>(
      '[data-worktree-virtual-row-key^="lineage-group:"]'
    )!
    return {
      scrollTop: element.scrollTop,
      groupTop: group.getBoundingClientRect().top - element.getBoundingClientRect().top,
      groupBottom: group.getBoundingClientRect().bottom - element.getBoundingClientRect().top
    }
  })
  expect(before.groupTop).toBeLessThan(0)
  expect(before.groupBottom).toBeGreaterThan(0)
  expect((await above.boundingBox())!.y + previousHeight).toBeLessThan(
    (await scroller.boundingBox())!.y
  )
  await seedWorkspaceAgentStatus(orcaPage, 'ordinary-79', 'ABOVE_LINEAGE_HEIGHT')
  await expect
    .poll(async () => (await above.boundingBox())!.height)
    .toBeGreaterThan(previousHeight + 10)
  await orcaPage.waitForTimeout(650)
  const after = await scroller.evaluate((element) => element.scrollTop)
  const drift = (await target.boundingBox())!.y - previousTop
  await writeFile(
    testInfo.outputPath('above-lineage-growth.json'),
    JSON.stringify({ targetId, before, after, drift })
  )
  expect(Math.abs(drift)).toBeLessThan(2)
  await orcaPage.screenshot({ path: testInfo.outputPath('above-lineage-growth.png') })
})

test('ordinary rows keep their anchor during measurement suppression with a distant lineage', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await seedOrdinaryRowsAboveLineage(orcaPage)
  await orcaPage.evaluate(() => {
    window.__store!.getState().revealWorktreeInSidebar('ordinary-30', { behavior: 'auto' })
  })
  const target = worktreeRow(orcaPage, 'ordinary-30')
  await expect(target).toBeInViewport()
  await target.evaluate((element) => {
    const scroller = element.closest<HTMLElement>('[data-worktree-sidebar]')!
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 40
  })
  await orcaPage.waitForTimeout(650)
  const previousTop = (await target.boundingBox())!.y
  const above = worktreeRow(orcaPage, 'ordinary-24')
  const previousHeight = (await above.boundingBox())!.height
  await orcaPage.locator('[data-worktree-sidebar]').evaluate((element) => {
    element.dispatchEvent(new Event('orca-record-virtualized-scroll-anchor'))
    element.dispatchEvent(new Event('scroll'))
  })
  await seedWorkspaceAgentStatus(orcaPage, 'ordinary-24', 'MIXED_HEIGHT')
  await expect
    .poll(async () => (await above.boundingBox())!.height)
    .toBeGreaterThan(previousHeight + 10)
  await expect
    .poll(async () => Math.abs((await target.boundingBox())!.y - previousTop))
    .toBeLessThan(2)
})

for (const requestKind of ['worktree', 'sidebar-row', 'rename'] as const) {
  test(`smooth ${requestKind} reveal keeps the inactive descendant mounted until its title lands`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, requestKind === 'sidebar-row')
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeVisible()
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const frames = await orcaPage.evaluate(async (requestKind) => {
      const targetId = 'e2e-virtual-child-400'
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      const samples: { mounted: boolean; top: number | null; scrollTop: number }[] = []
      const state = window.__store!.getState()
      if (requestKind === 'sidebar-row') {
        const firstKey = scroller.querySelector<HTMLElement>(
          '[data-worktree-id="e2e-virtual-child-0"]'
        )!.dataset.worktreeRowKey!
        state.revealSidebarRow(firstKey.replace('e2e-virtual-child-0', targetId), {
          behavior: 'smooth',
          highlight: false
        })
      } else {
        state.revealWorktreeInSidebar(targetId, {
          behavior: 'smooth',
          highlight: true,
          beginRename: requestKind === 'rename'
        })
      }
      const startedAt = performance.now()
      while (performance.now() - startedAt < 1_800) {
        await new Promise(requestAnimationFrame)
        const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
        samples.push({
          mounted: target !== null,
          top: target
            ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            : null,
          scrollTop: scroller.scrollTop
        })
      }
      return samples
    }, requestKind)
    await writeFile(
      testInfo.outputPath('smooth-reveal-frames.json'),
      JSON.stringify(frames, null, 2)
    )
    const firstMounted = frames.findIndex((frame) => frame.mounted)
    expect(firstMounted).toBeGreaterThanOrEqual(0)
    expect(frames.slice(firstMounted).every((frame) => frame.mounted)).toBe(true)
    const target = worktreeRow(orcaPage, 'e2e-virtual-child-400')
    if (requestKind === 'rename') {
      await expect(target.getByRole('textbox')).toBeInViewport()
      await expect(target.getByRole('textbox')).toHaveValue('Virtual child 400')
    } else {
      await expect(target.getByText('Virtual child 400', { exact: true })).toBeInViewport()
    }
    if (requestKind === 'worktree') {
      await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    }
    await orcaPage.screenshot({ path: testInfo.outputPath('smooth-reveal-landed.png') })
  })
}
