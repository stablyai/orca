import { test, expect } from './helpers/orca-app'

test('dismissing the sidebar create menu restores an empty workspace', async ({ orcaPage }) => {
  const worktreeId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    return worktreeId
  })
  const count = () =>
    orcaPage.evaluate(
      (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
      worktreeId
    )
  await expect.poll(count).toBe(0)
  await orcaPage
    .getByRole('button', { name: 'New tab', exact: true })
    .first()
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await expect.poll(count).toBe(0)
  await orcaPage.keyboard.press('Escape')
  await expect.poll(count).toBe(1)
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
})

test('the sidebar terminal entry keeps its workspace when activation changes', async ({
  orcaPage
}) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id !== worktreeId)!
    if (!state.tabsByWorktree[other.id]?.length) {
      state.createTab(other.id)
    }
    return { worktreeId, other: other.id, before: state.tabsByWorktree[worktreeId]?.length ?? 0 }
  })
  await orcaPage
    .getByRole('button', { name: 'New tab', exact: true })
    .first()
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  const otherCount = await orcaPage.evaluate((other) => {
    const state = window.__store!.getState()
    state.setActiveWorktree(other)
    return window.__store!.getState().tabsByWorktree[other]?.length ?? 0
  }, setup.other)
  await orcaPage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
        setup.worktreeId
      )
    )
    .toBe(setup.before + 1)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
      setup.other
    )
  ).toBe(otherCount)
})
