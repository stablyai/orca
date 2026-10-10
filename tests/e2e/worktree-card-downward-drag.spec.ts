import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

const SYNTHETIC_COUNT = 60

type PreviewOffsetSample = {
  worktreeId: string
  targetOffset: number
  renderedOffset: number
}

async function seedVirtualizedManualWorktrees(page: Page): Promise<{
  sourceId: string
  nextId: string
  idPrefix: string
}> {
  const repo = await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Expected a seeded e2e repo')
    }
    return { id: repo.id, path: repo.path }
  })
  const now = Date.now()
  const syntheticWorktrees = Array.from({ length: SYNTHETIC_COUNT }, (_, index) => {
    const suffix = String(index).padStart(2, '0')
    const worktreePath = path.join(repo.path, '..', `downward-drag-${suffix}`)
    return {
      id: `${repo.id}::downward-drag-${suffix}`,
      instanceId: `downward-drag-${suffix}`,
      repoId: repo.id,
      path: worktreePath,
      displayName: `Downward drag ${suffix}`,
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 100_000 - index,
      manualOrder: 100_000 - index,
      lastActivityAt: now - index,
      head: '0000000000000000000000000000000000000000',
      branch: `downward-drag-${suffix}`,
      isBare: false,
      isMainWorktree: false
    }
  })
  await page.evaluate(
    ({ repoId, worktrees }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const seededWorktrees = (state.worktreesByRepo[repoId] ?? []).map((worktree, index) => ({
        ...worktree,
        manualOrder: -1_000 - index
      }))

      store.setState({
        groupBy: 'none',
        sortBy: 'manual',
        showActiveOnly: false,
        showSleepingWorkspaces: true,
        hideDefaultBranchWorkspace: false,
        filterRepoIds: [],
        sidebarOpen: true,
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [repoId]: [...worktrees, ...seededWorktrees]
        },
        // Stands in for the real action only to skip its IPC persistence tail: these 60 rows
        // are store-only, so persisting them would fail and refetch them away mid-drag.
        updateWorktreesMeta: async (batchUpdates) => {
          if (batchUpdates.length === 0) {
            return
          }
          // executionHostId is ignored on purpose: every seeded row is host-less, which the
          // real action treats as local (worktree-meta-host-match.ts).
          const updatesByWorktreeId = new Map(
            batchUpdates.map((batchUpdate) => [batchUpdate.worktreeId, batchUpdate.updates])
          )
          store.setState((current) => ({
            sortEpoch: current.sortEpoch + 1,
            worktreesByRepo: Object.fromEntries(
              Object.entries(current.worktreesByRepo).map(([repoId, worktrees]) => [
                repoId,
                worktrees.map((worktree) => ({
                  ...worktree,
                  ...updatesByWorktreeId.get(worktree.id)
                }))
              ])
            )
          }))
        }
      })
    },
    { repoId: repo.id, worktrees: syntheticWorktrees }
  )
  const sourceId = syntheticWorktrees[0]!.id
  return {
    sourceId,
    nextId: syntheticWorktrees[1]!.id,
    idPrefix: sourceId.slice(0, -2)
  }
}

async function sampleMountedPreviewOffsets(
  page: Page,
  sourceId: string
): Promise<PreviewOffsetSample[][]> {
  return page.evaluate(async (draggedId) => {
    const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
    if (!scroller) {
      throw new Error('Worktree sidebar is not available')
    }
    const samples: PreviewOffsetSample[][] = []
    for (let frame = 0; frame < 20; frame++) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (document.querySelector(`[data-worktree-drag-id=${JSON.stringify(draggedId)}]`)) {
        continue
      }
      const frameSamples = [
        ...document.querySelectorAll<HTMLElement>('[data-worktree-virtual-row]')
      ].flatMap((row) => {
        const rowRect = row.getBoundingClientRect()
        const scrollerRect = scroller.getBoundingClientRect()
        if (rowRect.bottom <= scrollerRect.top || rowRect.top >= scrollerRect.bottom) {
          return []
        }
        const worktree = row.querySelector<HTMLElement>('[data-worktree-drag-id]')
        const worktreeId = worktree?.getAttribute('data-worktree-drag-id')
        const rowStart = Number(row.dataset.worktreeVirtualRowStart)
        const matches = [...row.style.transform.matchAll(/translateY\((-?[\d.]+)px\)/g)]
        const targetOffset = Number(matches[1]?.[1] ?? 0)
        const renderedTop = new DOMMatrixReadOnly(getComputedStyle(row).transform).m42
        const renderedOffset = renderedTop - rowStart
        return worktreeId &&
          Number.isFinite(rowStart) &&
          Number.isFinite(targetOffset) &&
          Number.isFinite(renderedOffset)
          ? [{ worktreeId, targetOffset, renderedOffset }]
          : []
      })
      if (frameSamples.length > 0) {
        samples.push(frameSamples)
      }
    }
    return samples
  }, sourceId)
}

test('dragging a virtualized worktree downward keeps rows stable', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1_000, height: 620 })
  const { sourceId, nextId, idPrefix } = await seedVirtualizedManualWorktrees(orcaPage)
  const scroller = orcaPage.locator('[data-worktree-sidebar]')
  const source = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(sourceId)}]`
  )
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect(source).toBeVisible()

  const sourceBox = await source.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })
  const nextSource = orcaPage.locator(
    `[data-worktree-sidebar] [data-worktree-id=${JSON.stringify(nextId)}]`
  )
  const sourceStride = await nextSource.evaluate(
    (element, sourceTop) => element.getBoundingClientRect().top - sourceTop,
    sourceBox.y
  )
  expect(Number.isFinite(sourceStride)).toBe(true)
  expect(sourceStride).toBeGreaterThan(1)
  const scrollerBox = await scroller.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
  })

  await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await orcaPage.mouse.down()
  try {
    const edgeX = scrollerBox.x + 2
    const edgeY = scrollerBox.y + scrollerBox.height - 8
    // Keep the pointer in the edge zone while the renderer advances autoscroll.
    for (let step = 0; step < 12; step++) {
      await orcaPage.mouse.move(edgeX, edgeY, { steps: 2 })
      if ((await source.count()) === 0) {
        break
      }
      await orcaPage.waitForTimeout(100)
    }
    if ((await source.count()) > 0) {
      for (let step = 0; step < 8 && (await source.count()) > 0; step++) {
        await scroller.evaluate((element) => {
          element.scrollTop = Math.min(
            element.scrollHeight,
            element.scrollTop + element.clientHeight
          )
          element.dispatchEvent(new Event('scroll', { bubbles: true }))
        })
        await orcaPage.waitForTimeout(100)
      }
    }
    await expect
      .poll(() => source.count(), {
        timeout: 10_000,
        message: 'Downward autoscroll did not virtualize the dragged source row'
      })
      .toBe(0)

    const samples = await sampleMountedPreviewOffsets(orcaPage, sourceId)
    expect(samples.length).toBeGreaterThan(0)
    const observationsById = new Map<string, PreviewOffsetSample[]>()
    for (const sample of samples.flat()) {
      const distanceFromValidTarget = Math.min(
        Math.abs(sample.targetOffset),
        Math.abs(sample.targetOffset + sourceStride)
      )
      expect(distanceFromValidTarget).toBeLessThanOrEqual(1)
      expect(sample.renderedOffset).toBeGreaterThanOrEqual(-sourceStride - 2)
      expect(sample.renderedOffset).toBeLessThanOrEqual(2)
      const observations = observationsById.get(sample.worktreeId) ?? []
      observations.push(sample)
      observationsById.set(sample.worktreeId, observations)
    }

    const recurrentRows = [...observationsById.values()].filter(
      (observations) => observations.length > 1
    )
    expect(recurrentRows.length).toBeGreaterThan(0)
    expect(
      recurrentRows.some((observations) =>
        observations.some((sample) => sample.renderedOffset <= -sourceStride * 0.8)
      )
    ).toBe(true)
    for (const observations of recurrentRows) {
      let renderedReversal = 0
      for (let index = 1; index < observations.length; index++) {
        renderedReversal += Math.max(
          0,
          observations[index]!.renderedOffset - observations[index - 1]!.renderedOffset
        )
      }
      expect(renderedReversal).toBeLessThanOrEqual(sourceStride)
    }
  } finally {
    await orcaPage.mouse.up()
  }

  await expect(orcaPage.locator('[data-worktree-sidebar-drag-preview="true"]')).toHaveCount(0)
  await expect(orcaPage.locator('html')).not.toHaveAttribute(
    'data-worktree-sidebar-pointer-dragging'
  )
  await scroller.evaluate((element) => {
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await expect
    .poll(
      () =>
        scroller
          .locator('[role="option"]')
          .evaluateAll(
            (options, prefix) =>
              options
                .map((option) => option.getAttribute('data-worktree-id'))
                .find((worktreeId) => worktreeId?.startsWith(prefix)) ?? null,
            idPrefix
          ),
      { message: 'The downward drop did not move the source away from the first slot' }
    )
    .toBe(nextId)
})
