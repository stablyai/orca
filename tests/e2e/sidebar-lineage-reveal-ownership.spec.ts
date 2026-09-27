import { writeFile } from 'node:fs/promises'
import { test, expect } from './sidebar-animation-fixture'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedVirtualLineage } from './sidebar-lineage-virtualization-state'
import { worktreeRow } from './worktree-row-locators'

for (const [firstKind, secondKind, firstIndex, secondIndex] of [
  ['worktree', 'worktree', 400, 100],
  ['worktree', 'sidebar-row', 400, 100],
  ['sidebar-row', 'worktree', 400, 100],
  ['worktree', 'worktree', 150, 150]
] as const) {
  test(`new ${secondKind} ${secondIndex} reveal replaces in-flight ${firstKind} ${firstIndex}`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(
      async ({ firstKind, secondKind, firstIndex, secondIndex }) => {
        const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
        const firstKey = scroller.querySelector<HTMLElement>(
          '[data-worktree-id="e2e-virtual-child-0"]'
        )!.dataset.worktreeRowKey!
        const request = (kind: 'worktree' | 'sidebar-row', index: number) => {
          const state = window.__store!.getState()
          const id = `e2e-virtual-child-${index}`
          if (kind === 'worktree') {
            state.revealWorktreeInSidebar(id, { behavior: 'smooth', highlight: true })
          } else {
            state.revealSidebarRow(firstKey.replace('e2e-virtual-child-0', id), {
              behavior: 'smooth',
              highlight: true
            })
          }
        }
        request(firstKind, firstIndex)
        await new Promise((resolve) => setTimeout(resolve, 200))
        const beforeReplacement = scroller.scrollTop
        await new Promise(requestAnimationFrame)
        const atReplacement = {
          before: beforeReplacement,
          offset: scroller.scrollTop,
          pending:
            firstKind === 'worktree'
              ? window.__store!.getState().pendingRevealWorktree?.worktreeId
              : window.__store!.getState().pendingRevealSidebarRow?.rowKey
        }
        request(secondKind, secondIndex)
        const start = performance.now()
        const samples: { time: number; top: number | null; scrollTop: number }[] = []
        while (performance.now() - start < 1_800) {
          await new Promise(requestAnimationFrame)
          const target = scroller.querySelector<HTMLElement>(
            `[data-worktree-id="e2e-virtual-child-${secondIndex}"]`
          )
          samples.push({
            time: performance.now() - start,
            scrollTop: scroller.scrollTop,
            top: target
              ? target.getBoundingClientRect().top - scroller.getBoundingClientRect().top
              : null
          })
        }
        const state = window.__store!.getState()
        return {
          samples,
          atReplacement,
          pendingWorktree: state.pendingRevealWorktree,
          pendingRow: state.pendingRevealSidebarRow
        }
      },
      { firstKind, secondKind, firstIndex, secondIndex }
    )
    await writeFile(testInfo.outputPath('replacement-frames.json'), JSON.stringify(result, null, 2))
    expect(result.atReplacement.pending).toBeTruthy()
    expect(result.atReplacement.offset).toBeGreaterThan(0)
    expect(result.atReplacement.offset).not.toBe(result.atReplacement.before)
    expect(
      Math.max(...result.samples.map((sample) => sample.scrollTop)) -
        result.samples.at(-1)!.scrollTop,
      'superseded destination cannot pull the scroller past its new target'
    ).toBeLessThanOrEqual(2)
    expect(result.pendingWorktree).toBeNull()
    expect(result.pendingRow).toBeNull()
    const target = worktreeRow(orcaPage, `e2e-virtual-child-${secondIndex}`)
    await expect(target.getByText(`Virtual child ${secondIndex}`, { exact: true })).toBeInViewport()
    await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    const top = (await target.boundingBox())!.y
    await orcaPage.waitForTimeout(350)
    expect(Math.abs((await target.boundingBox())!.y - top)).toBeLessThan(2)
  })
}

test('smooth reveal reaches the last descendant and returns to the first', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await seedVirtualLineage(orcaPage, false)
  await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
  await orcaPage.waitForTimeout(800)
  await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
  for (const index of [499, 0]) {
    await orcaPage.evaluate((index) => {
      window.__store!.getState().revealWorktreeInSidebar(`e2e-virtual-child-${index}`, {
        behavior: 'smooth',
        highlight: true
      })
    }, index)
    await orcaPage.waitForTimeout(1_800)
    const target = worktreeRow(orcaPage, `e2e-virtual-child-${index}`)
    await expect(target.getByText(`Virtual child ${index}`, { exact: true })).toBeInViewport()
    await expect(target).toHaveAttribute('data-scroll-reveal-highlight', 'true')
    expect(
      await orcaPage.evaluate(() => window.__store!.getState().pendingRevealWorktree)
    ).toBeNull()
  }
})

for (const interruption of ['wheel', 'cancel'] as const) {
  test(`${interruption} during the measured approach prevents delayed reveal writes`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await seedVirtualLineage(orcaPage, false)
    await expect(worktreeRow(orcaPage, 'e2e-virtual-child-0')).toBeInViewport()
    await orcaPage.waitForTimeout(800)
    await orcaPage.emulateMedia({ reducedMotion: 'no-preference' })
    const result = await orcaPage.evaluate(async (interruption) => {
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')!
      const originalScrollTo = scroller.scrollTo.bind(scroller)
      const startedAt = performance.now()
      const writes: { time: number; from: number; top: number; behavior?: string }[] = []
      let smoothWrites = 0
      scroller.scrollTo = (options?: ScrollToOptions | number, y?: number) => {
        if (typeof options === 'number') {
          originalScrollTo(options, y ?? 0)
        } else {
          writes.push({
            time: performance.now() - startedAt,
            from: scroller.scrollTop,
            top: options?.top ?? scroller.scrollTop,
            behavior: options?.behavior
          })
          if (options?.behavior === 'smooth') {
            smoothWrites++
          }
          originalScrollTo(options)
        }
      }
      const geometry = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect()
        const top = bounds.top - scroller.getBoundingClientRect().top + scroller.scrollTop
        return { top, end: top + bounds.height, height: bounds.height }
      }
      let grownTarget: HTMLElement | null = null
      let originalMinHeight = ''
      let growth: {
        time: number
        before: ReturnType<typeof geometry>
        after: ReturnType<typeof geometry>
        viewportHeight: number
      } | null = null
      try {
        window.__store!.getState().revealWorktreeInSidebar('e2e-virtual-child-150', {
          behavior: 'smooth',
          highlight: true
        })
        let previousOffset = scroller.scrollTop
        let moving = false
        while (performance.now() - startedAt < 1_500) {
          await new Promise(requestAnimationFrame)
          moving = Math.abs(scroller.scrollTop - previousOffset) > 1
          if (!growth && smoothWrites === 1 && moving) {
            const target = scroller.querySelector<HTMLElement>(
              '[data-worktree-id="e2e-virtual-child-150"]'
            )!
            const before = geometry(target)
            grownTarget = target
            originalMinHeight = target.style.minHeight
            // Real layout growth exercises retargeting even when initial estimates are exact.
            target.style.minHeight = `${before.height + 80}px`
            growth = {
              time: performance.now() - startedAt,
              before,
              after: geometry(target),
              viewportHeight: scroller.clientHeight
            }
          }
          if (growth && smoothWrites >= 2 && moving) {
            break
          }
          previousOffset = scroller.scrollTop
        }
        const atInterruption = {
          time: performance.now() - startedAt,
          smoothWrites,
          moving,
          offset: scroller.scrollTop,
          pending: window.__store!.getState().pendingRevealWorktree?.worktreeId
        }
        if (interruption === 'wheel') {
          scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }))
        } else {
          window.__store!.getState().clearPendingRevealWorktreeId()
        }
        scroller.scrollTo({ top: scroller.scrollTop - 200, behavior: 'instant' })
        await new Promise(requestAnimationFrame)
        const offset = scroller.scrollTop
        const start = performance.now()
        const samples: { time: number; scrollTop: number; highlighted: boolean }[] = []
        while (performance.now() - start < 1_200) {
          await new Promise(requestAnimationFrame)
          const target = scroller.querySelector('[data-worktree-id="e2e-virtual-child-150"]')
          samples.push({
            time: performance.now() - start,
            scrollTop: scroller.scrollTop,
            highlighted: target?.getAttribute('data-scroll-reveal-highlight') === 'true'
          })
        }
        return {
          growth,
          writes,
          offset,
          samples,
          atInterruption,
          pending: window.__store!.getState().pendingRevealWorktree
        }
      } finally {
        scroller.scrollTo = originalScrollTo
        if (grownTarget) {
          grownTarget.style.minHeight = originalMinHeight
        }
      }
    }, interruption)
    await writeFile(
      testInfo.outputPath('interruption-frames.json'),
      JSON.stringify(result, null, 2)
    )
    expect(result.atInterruption.pending).toBe('e2e-virtual-child-150')
    expect(result.atInterruption.smoothWrites).toBeGreaterThanOrEqual(2)
    expect(result.atInterruption.moving).toBe(true)
    expect(result.growth).not.toBeNull()
    const growth = result.growth!
    expect(growth.after.height - growth.before.height).toBeGreaterThan(70)
    expect(growth.after.height).toBeLessThan(growth.viewportHeight - 34)
    const smoothWrites = result.writes.filter((write) => write.behavior === 'smooth')
    expect(smoothWrites[1]!.time).toBeGreaterThan(growth.time)
    expect(smoothWrites[1]!.time).toBeLessThan(1_500)
    expect(smoothWrites[1]!.time).toBeLessThanOrEqual(result.atInterruption.time)
    expect(
      Math.abs(smoothWrites[1]!.top - smoothWrites[0]!.top - (growth.after.end - growth.before.end))
    ).toBeLessThan(2)
    expect(result.pending).toBeNull()
    expect(result.samples.every((sample) => !sample.highlighted)).toBe(true)
    expect(
      Math.max(...result.samples.map((sample) => Math.abs(sample.scrollTop - result.offset)))
    ).toBeLessThan(2)
  })
}
