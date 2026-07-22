import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

type LongDragScenario = {
  childId: string
  parentId: string
  sourceId: string
}

async function seedLongDragScenario(page: Page): Promise<LongDragScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const repo = state.repos[0]
    const template = repo ? state.worktreesByRepo[repo.id]?.[0] : undefined
    if (!repo || !template) {
      throw new Error('Expected a seeded E2E workspace')
    }

    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('manual')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])

    const syntheticWorktrees = Array.from({ length: 60 }, (_, index) => {
      const suffix = String(index).padStart(2, '0')
      return {
        ...template,
        id: `${repo.id}::drag-autoscroll-${suffix}`,
        instanceId: `drag-autoscroll-${suffix}`,
        path: `${template.path}-drag-autoscroll-${suffix}`,
        displayName: `Drag autoscroll ${suffix}`,
        branch: `drag-autoscroll-${suffix}`,
        isMainWorktree: false,
        manualOrder: 60 - index,
        sortOrder: 60 - index
      }
    })
    // Why: keep the lineage pair in the viewport after the drag has autoscrolled
    // far enough to exercise virtual row refresh and measurement correction.
    const parent = syntheticWorktrees[50]!
    const child = syntheticWorktrees[51]!
    const source = syntheticWorktrees[59]!

    store.setState((current) => ({
      worktreesByRepo: {
        ...current.worktreesByRepo,
        [repo.id]: [
          ...(current.worktreesByRepo[repo.id] ?? []).map((worktree, index) => ({
            ...worktree,
            manualOrder: 100_000 - index
          })),
          ...syntheticWorktrees
        ]
      },
      worktreeLineageById: {
        ...current.worktreeLineageById,
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: Date.now()
        }
      }
    }))
    return { childId: child.id, parentId: parent.id, sourceId: source.id }
  })
}

test('keeps virtualized lineage rows populated while dragging upward', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const scenario = await seedLongDragScenario(orcaPage)
  const scroller = orcaPage.locator('[data-worktree-sidebar]')

  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(1000)
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })

  const source = worktreeRow(orcaPage, scenario.sourceId)
  const parent = worktreeRow(orcaPage, scenario.parentId)
  const child = worktreeRow(orcaPage, scenario.childId)
  await expect(source).toBeVisible()
  await expect(parent).toBeVisible()
  await expect(child).toBeVisible()

  const initialScrollTop = await scroller.evaluate((element) => element.scrollTop)
  const sourceBox = await source.boundingBox()
  const scrollerBox = await scroller.boundingBox()
  if (!sourceBox || !scrollerBox) {
    throw new Error('Expected sidebar drag geometry')
  }
  const initialLineageGap = await child.evaluate((element, parentId) => {
    const parent = [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
      (candidate) => candidate.dataset.worktreeId === parentId
    )
    if (!parent) {
      throw new Error('Expected mounted lineage parent')
    }
    return element.getBoundingClientRect().top - parent.getBoundingClientRect().top
  }, scenario.parentId)

  await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await orcaPage.mouse.down()
  try {
    await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, scrollerBox.y + 8, { steps: 12 })
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThan(initialScrollTop - 200)

    const draggedGeometry = await orcaPage.evaluate(({ childId, parentId }) => {
      const scroller = document.querySelector<HTMLElement>('[data-worktree-sidebar]')
      const rowFor = (worktreeId: string) =>
        [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
          (candidate) => candidate.dataset.worktreeId === worktreeId
        )
      const parent = rowFor(parentId)
      const child = rowFor(childId)
      if (!scroller || !parent || !child) {
        return null
      }
      const scrollerRect = scroller.getBoundingClientRect()
      const parentRect = parent.getBoundingClientRect()
      const childRect = child.getBoundingClientRect()
      return {
        lineageGap: childRect.top - parentRect.top,
        parentIntersectsViewport:
          parentRect.bottom > scrollerRect.top && parentRect.top < scrollerRect.bottom
      }
    }, scenario)
    expect(draggedGeometry).not.toBeNull()
    expect(draggedGeometry!.parentIntersectsViewport).toBe(true)
    expect(draggedGeometry!.lineageGap).toBeCloseTo(initialLineageGap, 0)
  } finally {
    await orcaPage.mouse.up()
  }
})
