import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

for (const firstKind of ['worktree', 'sidebar-row'] as const) {
  test(`a visible replacement stops the old ${firstKind} native destination`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(async (firstKind) => {
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      const firstKey = scroller.querySelector<HTMLElement>(
        '[data-worktree-id="e2e-virtual-child-0"]'
      )!.dataset.worktreeRowKey!
      const state = window.__store!.getState()
      if (firstKind === 'worktree') {
        state.revealWorktreeInSidebar('e2e-virtual-child-150', {
          behavior: 'smooth',
          highlight: true
        })
      } else {
        state.revealSidebarRow(firstKey.replace('e2e-virtual-child-0', 'e2e-virtual-child-150'), {
          behavior: 'smooth',
          highlight: true
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
      const previousOffset = scroller.scrollTop
      await new Promise(requestAnimationFrame)
      const bounds = scroller.getBoundingClientRect()
      const visible = [
        ...scroller.querySelectorAll<HTMLElement>('[data-worktree-id^="e2e-virtual-child-"]')
      ].findLast((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top >= bounds.top + 100 && rect.bottom <= bounds.top + scroller.clientHeight
      })
      if (!visible) {
        throw new Error('No fully visible replacement during native motion')
      }
      const targetId = visible.dataset.worktreeId!
      const targetKey = visible.dataset.worktreeRowKey!
      const atReplacement = {
        previousOffset,
        offset: scroller.scrollTop,
        pending:
          firstKind === 'worktree'
            ? window.__store!.getState().pendingRevealWorktree
            : window.__store!.getState().pendingRevealSidebarRow,
        top: visible.getBoundingClientRect().top - bounds.top,
        bottom: visible.getBoundingClientRect().bottom - bounds.top
      }
      if (firstKind === 'worktree') {
        state.revealSidebarRow(targetKey, { behavior: 'smooth', highlight: true })
      } else {
        state.revealWorktreeInSidebar(targetId, { behavior: 'smooth', highlight: true })
      }
      const startedAt = performance.now()
      const samples: {
        time: number
        scrollTop: number
        top: number | null
        highlighted: boolean
      }[] = []
      while (performance.now() - startedAt < 1_800) {
        await new Promise(requestAnimationFrame)
        const target = scroller.querySelector<HTMLElement>(`[data-worktree-id="${targetId}"]`)
        samples.push({
          time: performance.now() - startedAt,
          scrollTop: scroller.scrollTop,
          top: target
            ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
            : null,
          highlighted: target?.getAttribute('data-scroll-reveal-highlight') === 'true'
        })
      }
      return {
        samples,
        targetId,
        atReplacement,
        height: scroller.clientHeight,
        pendingWorktree: window.__store!.getState().pendingRevealWorktree,
        pendingRow: window.__store!.getState().pendingRevealSidebarRow
      }
    }, firstKind)
    await writeFile(
      testInfo.outputPath('visible-replacement-frames.json'),
      JSON.stringify(result, null, 2)
    )
    expect(result.atReplacement.pending).not.toBeNull()
    expect(result.atReplacement.offset).toBeGreaterThan(0)
    expect(result.atReplacement.offset).not.toBe(result.atReplacement.previousOffset)
    expect(result.atReplacement.top).toBeGreaterThanOrEqual(100)
    expect(result.atReplacement.bottom).toBeLessThanOrEqual(result.height)
    expect(result.pendingWorktree).toBeNull()
    expect(result.pendingRow).toBeNull()
    expect(result.samples.some((sample) => sample.highlighted)).toBe(true)
    expect(
      result.samples.every(
        (sample) => sample.top !== null && sample.top >= 0 && sample.top < result.height
      )
    ).toBe(true)
    expect(
      Math.max(...result.samples.map((sample) => sample.scrollTop)) -
        result.samples.at(-1)!.scrollTop
    ).toBeLessThanOrEqual(2)
    const target = worktreeRow(orcaPage, result.targetId)
    await expect(target).toBeInViewport()
    const top = (await target.boundingBox())!.y
    await orcaPage.waitForTimeout(350)
    expect(Math.abs((await target.boundingBox())!.y - top)).toBeLessThan(2)
  })
}
