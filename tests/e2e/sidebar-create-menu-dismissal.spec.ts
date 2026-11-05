import { worktreeRow } from './worktree-row-locators'
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
  await worktreeRow(orcaPage, worktreeId)
    .getByRole('button', { name: 'New tab', exact: true })
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
    return {
      worktreeId,
      other: other.id,
      before: state.tabsByWorktree[worktreeId]?.map((tab) => tab.id) ?? []
    }
  })
  await worktreeRow(orcaPage, setup.worktreeId)
    .getByRole('button', { name: 'New tab', exact: true })
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
    .toBe(setup.before.length + 1)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
      setup.other
    )
  ).toBe(otherCount)
  const createdId = await orcaPage.evaluate((setup) => {
    const state = window.__store!.getState()
    const created = state.tabsByWorktree[setup.worktreeId].find(
      (tab) => !setup.before.includes(tab.id)
    )!
    state.setActiveWorktree(setup.worktreeId)
    return created.id
  }, setup)
  await expect(
    orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${createdId}"]`)
  ).toBeVisible()
})

test('an async Markdown selection does not also seed a terminal', async ({ orcaPage }) => {
  const worktreeId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const id = state.activeWorktreeId!
    for (const tab of state.tabsByWorktree[id] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    const original = state.openNewMarkdownInActiveWorkspace
    window.__store!.setState({
      openNewMarkdownInActiveWorkspace: async (groupId) => {
        await new Promise<void>((resolve) =>
          window.addEventListener('test-release-markdown', () => resolve(), { once: true })
        )
        return original(groupId)
      }
    })
    return id
  })
  await worktreeRow(orcaPage, worktreeId)
    .getByRole('button', { name: 'New tab', exact: true })
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage
    .getByRole('menuitem', { name: /New Markdown/i })
    .first()
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeHidden()
  await orcaPage.evaluate(() => window.dispatchEvent(new Event('test-release-markdown')))
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) =>
          window.__store!.getState().openFiles.filter((file) => file.worktreeId === id).length,
        worktreeId
      )
    )
    .toBe(1)
  expect(
    await orcaPage.evaluate((id) => window.__store!.getState().tabsByWorktree[id] ?? [], worktreeId)
  ).toEqual([])
  await expect(
    orcaPage.getByRole('button', { name: /^untitled(?:-\d+)?\.md .*Close tab$/ })
  ).toBeVisible()
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(0)
})

test('Markdown creation uses the menu group after another workspace becomes active', async ({
  orcaPage
}) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((row) => row.id !== worktreeId)!
    if (!state.tabsByWorktree[other.id]?.length) {
      state.createTab(other.id)
    }
    return { worktreeId, other: other.id }
  })
  await worktreeRow(orcaPage, setup.worktreeId)
    .getByRole('button', { name: 'New tab', exact: true })
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.evaluate((id) => window.__store!.getState().setActiveWorktree(id), setup.other)
  await orcaPage
    .getByRole('menuitem', { name: /New Markdown/i })
    .first()
    .click({ force: true })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) =>
          window.__store!.getState().openFiles.filter((file) => file.worktreeId === id).length,
        setup.worktreeId
      )
    )
    .toBe(1)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store!.getState().openFiles.filter((file) => file.worktreeId === id),
      setup.other
    )
  ).toEqual([])
  await orcaPage.evaluate(
    (id) => window.__store!.getState().setActiveWorktree(id),
    setup.worktreeId
  )
  await expect(
    orcaPage.getByRole('button', { name: /^untitled(?:-\d+)?\.md .*Close tab$/ })
  ).toBeVisible()
})
