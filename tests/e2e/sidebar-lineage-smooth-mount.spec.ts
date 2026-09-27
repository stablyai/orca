import { writeFile } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  expectSidebarScrollProgress,
  isSidebarScrollIntermediate,
  measureSidebarScroll,
  type SidebarScrollSample
} from './sidebar-scroll-timeline'
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
    // Keep the destination beyond both retained endpoint windows so travel mounts new lineages.
    const targetId = 'smooth-parent-60'
    const readLineageIds = (): string[] =>
      [...scroller.querySelectorAll('[data-lineage-virtual-children]')].map((element) => {
        const key = element.closest<HTMLElement>('[data-worktree-virtual-row-key]')?.dataset
          .worktreeVirtualRowKey
        if (!key) {
          throw new Error('Mounted lineage has no stable row identity')
        }
        return key
      })
    const lineageIdsBefore = readLineageIds()
    const lineageBefore = lineageIdsBefore.length
    const samples: (SidebarScrollSample & { groups: number; lineageIds: string[] })[] = []
    let captureTimedOut = false
    const initialOffset = scroller.scrollTop
    const startedAt = performance.now()
    window.__store!.getState().revealWorktreeInSidebar(targetId, {
      behavior: 'smooth',
      highlight: true
    })
    while (performance.now() - startedAt < 4_000) {
      const observed = await new Promise<boolean>((resolve) => {
        const frame = requestAnimationFrame(() => {
          clearTimeout(timeout)
          resolve(true)
        })
        const timeout = setTimeout(
          () => {
            cancelAnimationFrame(frame)
            resolve(false)
          },
          Math.max(0, 4_500 - (performance.now() - startedAt))
        )
      })
      if (!observed) {
        captureTimedOut = true
        break
      }
      const row = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
      const rect = row?.getBoundingClientRect()
      const content = row?.querySelector<HTMLElement>('[data-worktree-title-inline-rename]')
      const contentRect = content?.getBoundingClientRect()
      const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop
      const lineageIds = readLineageIds()
      samples.push({
        time: performance.now() - startedAt,
        scrollTop: scroller.scrollTop,
        highlighted: row?.dataset.scrollRevealHighlight === 'true',
        geometry:
          rect && contentRect && content
            ? {
                top: rect.top - viewportTop,
                height: rect.height,
                viewportHeight: scroller.clientHeight,
                contentTop: contentRect.top - viewportTop,
                contentHeight: contentRect.height,
                contentVisible: content.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true
                })
              }
            : null,
        groups: lineageIds.length,
        lineageIds
      })
    }
    return {
      targetId,
      initialOffset,
      captureTimedOut,
      lineageBefore,
      lineageIdsBefore,
      sidebarHeight: scroller.clientHeight,
      samples
    }
  })

  const metrics = measureSidebarScroll(result.samples, result.initialOffset, result)
  const { finalOffset, longestPause } = metrics
  const intermediateMounts = result.samples.filter(
    (sample, index) =>
      index > 0 &&
      sample.lineageIds.some(
        (id) => !(result.samples[index - 1]?.lineageIds ?? result.lineageIdsBefore).includes(id)
      ) &&
      isSidebarScrollIntermediate(sample, metrics)
  ).length
  console.log(
    '[sidebar-smooth-mount]',
    JSON.stringify({ ...metrics, intermediateMounts, sidebarHeight: result.sidebarHeight })
  )
  await writeFile(
    testInfo.outputPath('smooth-mount-timeline.json'),
    JSON.stringify({ ...result, ...metrics, intermediateMounts }, null, 2)
  )
  expectSidebarScrollProgress(metrics)
  expect(finalOffset).toBeGreaterThan(400)
  expect(
    result.samples.some(
      (sample) =>
        sample.groups > result.lineageBefore && isSidebarScrollIntermediate(sample, metrics)
    )
  ).toBe(true)
  expect(intermediateMounts, 'new lineage mounts during intermediate motion').toBeGreaterThan(0)
  // A timeout correction can reach the right endpoint after a visibly stalled animation.
  expect(longestPause).toBeLessThan(200)
  expect(metrics.maxReverseStep, 'no backtracking').toBeLessThanOrEqual(2)
  expect(metrics.maxOvershoot, 'no overshoot').toBeLessThanOrEqual(2)
  const target = worktreeRow(orcaPage, result.targetId)
  await expect(target.getByText(/^Smooth parent \d+$/, { exact: true })).toBeInViewport()
  expect(metrics.highlightedAfterArrival, 'target highlighted at visible landing').toBe(true)
  await scroller.screenshot({ path: testInfo.outputPath('smooth-mount-landed.png') })
})
