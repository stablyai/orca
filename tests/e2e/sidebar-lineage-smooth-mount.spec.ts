import { writeFile } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

async function seedInterleavedLineages(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store!
    const state = store.getState()
    const [base, template] = Object.values(state.worktreesByRepo).flat()
    if (!base || !template) {
      throw new Error('Lineage fixtures unavailable')
    }
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('manual')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])
    state.setWorktreeCardProperties(['status', 'branch', 'inline-agents'])
    const worktrees = Array.from({ length: 80 }, (_, index) => {
      const parent = {
        ...template,
        id: `smooth-parent-${index}`,
        instanceId: `smooth-parent-instance-${index}`,
        repoId: base.repoId,
        hostId: base.hostId,
        displayName: `Smooth parent ${index}`,
        isPinned: false,
        isMainWorktree: false,
        sortOrder: 10_000 - index * 10,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null
      }
      if (index % 3 !== 0) {
        return [parent]
      }
      const id = `smooth-child-${index}`
      const instanceId = `smooth-child-instance-${index}`
      return [
        parent,
        {
          ...parent,
          id,
          instanceId,
          displayName: `Smooth child ${index}`,
          sortOrder: parent.sortOrder - 1,
          parentWorktreeId: parent.id,
          lineage: {
            worktreeId: id,
            worktreeInstanceId: instanceId,
            parentWorktreeId: parent.id,
            parentWorktreeInstanceId: parent.instanceId,
            origin: 'manual' as const,
            capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
            createdAt: 1
          }
        }
      ]
    }).flat()
    store.setState((current) => ({
      settings: current.settings
        ? { ...current.settings, experimentalNewWorktreeCardStyle: false }
        : current.settings,
      worktreesByRepo: {
        [base.repoId]: [{ ...base, isPinned: false, sortOrder: 20_000 }, ...worktrees]
      },
      worktreeLineageById: Object.fromEntries(
        worktrees.flatMap((worktree) => (worktree.lineage ? [[worktree.id, worktree.lineage]] : []))
      ),
      collapsedGroups: new Set(),
      sortEpoch: current.sortEpoch + 1
    }))
    store.getState().setActiveWorktree(base.id)
  })
}

test('smooth reveal keeps moving while another lineage mounts', async ({ orcaPage }, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedInterleavedLineages(orcaPage)
  await expect(worktreeRow(orcaPage, 'smooth-parent-0')).toBeInViewport()
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  await scroller.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
  await orcaPage.waitForTimeout(800)

  const result = await orcaPage.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
    const containerTop = scroller.getBoundingClientRect().top
    const target = [
      ...scroller.querySelectorAll<HTMLElement>('[data-worktree-id^="smooth-parent-"]')
    ].findLast(
      (element) => element.getBoundingClientRect().top - containerTop > scroller.clientHeight + 200
    )
    if (!target?.dataset.worktreeId) {
      throw new Error('Expected a mounted overscan target below the viewport')
    }
    const lineageBefore = scroller.querySelectorAll('[data-lineage-virtual-children]').length
    const samples: { time: number; scrollTop: number; groups: number }[] = []
    const startedAt = performance.now()
    window.__store!.getState().revealWorktreeInSidebar(target.dataset.worktreeId, {
      behavior: 'smooth',
      highlight: true
    })
    while (performance.now() - startedAt < 1_800) {
      await new Promise(requestAnimationFrame)
      samples.push({
        time: performance.now() - startedAt,
        scrollTop: scroller.scrollTop,
        groups: scroller.querySelectorAll('[data-lineage-virtual-children]').length
      })
    }
    return { targetId: target.dataset.worktreeId, lineageBefore, samples }
  })

  const finalOffset = result.samples.at(-1)!.scrollTop
  let lastOffset = 0
  let stationarySince = 0
  let longestPause = 0
  for (const sample of result.samples) {
    if (sample.scrollTop !== lastOffset) {
      lastOffset = sample.scrollTop
      stationarySince = sample.time
    } else if (sample.scrollTop > 1 && Math.abs(sample.scrollTop - finalOffset) > 2) {
      longestPause = Math.max(longestPause, sample.time - stationarySince)
    }
  }
  await writeFile(
    testInfo.outputPath('smooth-mount-timeline.json'),
    JSON.stringify({ ...result, finalOffset, longestPause }, null, 2)
  )
  expect(finalOffset).toBeGreaterThan(400)
  expect(
    result.samples.some(
      (sample) => sample.groups > result.lineageBefore && sample.scrollTop < finalOffset - 2
    )
  ).toBe(true)
  // A timeout correction can reach the right endpoint after a visibly stalled animation.
  expect(longestPause).toBeLessThan(200)
  const target = worktreeRow(orcaPage, result.targetId)
  await expect(target.getByText(/^Smooth parent \d+$/, { exact: true })).toBeInViewport()
  await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
  await scroller.screenshot({ path: testInfo.outputPath('smooth-mount-landed.png') })
})
