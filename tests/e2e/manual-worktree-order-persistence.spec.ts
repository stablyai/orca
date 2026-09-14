import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

async function visibleWorktreeIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-worktree-sidebar] [role="option"][data-worktree-id]')
    .evaluateAll((elements) =>
      elements
        .map((element) => ({
          id: element.getAttribute('data-worktree-id') ?? '',
          top: element.getBoundingClientRect().top
        }))
        .sort((left, right) => left.top - right.top)
        .map((entry) => entry.id)
    )
}

async function dragBefore(page: Page, sourceId: string, targetId: string): Promise<void> {
  const source = page.locator(`[data-worktree-id=${JSON.stringify(sourceId)}]`).first()
  const target = page.locator(`[data-worktree-id=${JSON.stringify(targetId)}]`).first()
  await expect(source).toBeVisible()
  await expect(target).toBeVisible()
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) {
    throw new Error('Manual-order drag geometry was unavailable')
  }
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 3, { steps: 8 })
  await page.mouse.up()
}

test('manual drag survives activity and persisted-profile reload', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const session = createRestartSession(testInfo)
  let firstApp: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  let secondApp: Awaited<ReturnType<typeof session.launch>>['app'] | null = null
  let createdIds: string[] = []

  try {
    const first = await session.launch()
    firstApp = first.app
    await waitForSessionReady(first.page)
    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    createdIds = await first.page.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      const state = store.getState()
      state.setGroupBy('none')
      state.setSortBy('smart')
      state.setShowSleepingWorkspaces(true)
      const repoId = state.allWorktrees()[0]?.repoId
      if (!repoId) {
        throw new Error('seed repo was not loaded')
      }
      const names = ['manual-order-a', 'manual-order-b', 'manual-order-c']
      const created: string[] = []
      for (const name of names) {
        created.push((await state.createWorktree(repoId, name, undefined, 'skip')).worktree.id)
      }
      return created
    })

    await expect
      .poll(
        () =>
          first.page
            .locator('[data-worktree-sidebar] [role="option"][data-worktree-id]')
            .evaluateAll(
              (elements, ids) =>
                ids.every((id) =>
                  elements.some((element) => element.getAttribute('data-worktree-id') === id)
                ),
              createdIds
            ),
        { timeout: 30_000 }
      )
      .toBe(true)
    const initialOrder = (await visibleWorktreeIds(first.page)).filter((id) =>
      createdIds.includes(id)
    )
    const sourceId = createdIds.at(-1)!
    const targetId = initialOrder.find((id) => id !== sourceId)!
    await dragBefore(first.page, sourceId, targetId)

    const manualOrderAfterDrag = await first.page.evaluate((ids) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      return {
        sortBy: state.sortBy,
        rows: state
          .allWorktrees()
          .map((worktree) => ({
            id: worktree.id,
            manualOrder: worktree.manualOrder,
            sortOrder: worktree.sortOrder
          }))
          .filter((row) => ids.includes(row.id))
      }
    }, createdIds)
    expect(manualOrderAfterDrag.sortBy).toBe('manual')
    expect(manualOrderAfterDrag.rows.every((row) => Number.isFinite(row.manualOrder))).toBe(true)
    const expectedOrder = [...manualOrderAfterDrag.rows]
      .sort((left, right) => (right.manualOrder ?? 0) - (left.manualOrder ?? 0))
      .map((row) => row.id)
    expect((await visibleWorktreeIds(first.page)).filter((id) => createdIds.includes(id))).toEqual(
      expectedOrder
    )

    const sortOrdersBeforeActivity = new Map(
      manualOrderAfterDrag.rows.map((row) => [row.id, row.sortOrder])
    )
    await first.page.evaluate(async (activityId) => {
      const store = window.__store
      if (!store) {
        throw new Error('store unavailable')
      }
      store.getState().bumpWorktreeActivity(activityId)
      const orderedIds = store
        .getState()
        .allWorktrees()
        .map((worktree) => worktree.id)
        .filter((id) => id !== activityId)
      await window.api.worktrees.persistSortOrder({ orderedIds: [activityId, ...orderedIds] })
      await store.getState().fetchAllWorktrees()
    }, targetId)
    await expect
      .poll(() =>
        first.page.evaluate((activityId) => {
          const row = window.__store
            ?.getState()
            .allWorktrees()
            .find((worktree) => worktree.id === activityId)
          return row?.sortOrder
        }, targetId)
      )
      .not.toBe(sortOrdersBeforeActivity.get(targetId))
    await expect
      .poll(() =>
        visibleWorktreeIds(first.page).then((ids) => ids.filter((id) => createdIds.includes(id)))
      )
      .toEqual(expectedOrder)

    await expect
      .poll(async () => {
        const [ui, worktrees] = await first.page.evaluate(async (ids) => {
          const [persistedUi, persistedWorktrees] = await Promise.all([
            window.api.ui.get(),
            window.api.worktrees.listAll()
          ])
          return [
            persistedUi,
            persistedWorktrees
              .filter((worktree) => ids.includes(worktree.id))
              .map((worktree) => ({ id: worktree.id, manualOrder: worktree.manualOrder }))
          ] as const
        }, createdIds)
        return {
          sortBy: ui.sortBy,
          ranks: Object.fromEntries(worktrees.map((row) => [row.id, row.manualOrder]))
        }
      })
      .toEqual({
        sortBy: 'manual',
        ranks: Object.fromEntries(manualOrderAfterDrag.rows.map((row) => [row.id, row.manualOrder]))
      })

    await session.close(firstApp)
    firstApp = null
    const second = await session.launch()
    secondApp = second.app
    await waitForSessionReady(second.page)
    const reloadedState = await second.page.evaluate((ids) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('store unavailable')
      }
      return {
        sortBy: state.sortBy,
        rows: state
          .allWorktrees()
          .filter((worktree) => ids.includes(worktree.id))
          .map((worktree) => ({ id: worktree.id, manualOrder: worktree.manualOrder }))
      }
    }, createdIds)
    expect(reloadedState.sortBy).toBe('manual')
    const reloadedRows = reloadedState.rows
    expect(reloadedRows.every((row) => Number.isFinite(row.manualOrder))).toBe(true)
    expect(reloadedRows.map((row) => row.id).sort()).toEqual(expectedOrder.slice().sort())
    expect(new Map(reloadedRows.map((row) => [row.id, row.manualOrder]))).toEqual(
      new Map(manualOrderAfterDrag.rows.map((row) => [row.id, row.manualOrder]))
    )
    await expect
      .poll(
        () =>
          visibleWorktreeIds(second.page).then((ids) =>
            ids.filter((id) => createdIds.includes(id))
          ),
        { timeout: 30_000 }
      )
      .toEqual(expectedOrder)
  } finally {
    if (secondApp && createdIds.length > 0) {
      await secondApp
        .firstWindow()
        .then((page) =>
          page.evaluate(async (ids) => {
            for (const id of ids) {
              await window.__store?.getState().removeWorktree({ id, executionHostId: null }, true)
            }
          }, createdIds)
        )
        .catch(() => undefined)
    }
    for (const app of [secondApp, firstApp]) {
      if (app) {
        await session.close(app).catch(() => undefined)
      }
    }
    await session.dispose()
  }
})
