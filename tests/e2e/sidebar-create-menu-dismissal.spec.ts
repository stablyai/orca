import { tabCreateMenuTrigger } from './helpers/terminal-tab-menu'
import { rm } from 'node:fs/promises'
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
  await expect
    .poll(() =>
      worktreeRow(orcaPage, worktreeId)
        .getByRole('button', { name: 'New tab', exact: true })
        .evaluate((node) => node === document.activeElement)
    )
    .toBe(true)
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

test('an async Markdown selection does not also seed a terminal', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const worktreeId = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const id = state.activeWorktreeId!
    for (const tab of state.tabsByWorktree[id] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    const original = state.openNewMarkdownInActiveWorkspace
    window.__store!.setState({
      openNewMarkdownInActiveWorkspace: async (...args) => {
        await new Promise<void>((resolve) =>
          window.addEventListener('test-release-markdown', () => resolve(), { once: true })
        )
        return original(...args)
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
  const createdPath = await orcaPage.evaluate(
    (id) => window.__store!.getState().openFiles.find((file) => file.worktreeId === id)!.filePath,
    worktreeId
  )
  registerPostElectronShutdownCleanup(() => rm(createdPath, { force: true }))
  expect(
    await orcaPage.evaluate((id) => window.__store!.getState().tabsByWorktree[id] ?? [], worktreeId)
  ).toEqual([])
  await expect(
    orcaPage.getByRole('button', { name: /^untitled(?:-\d+)?\.md .*Close tab$/ })
  ).toBeVisible()
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(0)
})

test('Markdown creation keeps an empty workspace after activation changes', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
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
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    window.__store!.setState((s) => ({
      groupsByWorktree: { ...s.groupsByWorktree, [worktreeId]: [] }
    }))
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
  const createdPath = await orcaPage.evaluate(
    (id) => window.__store!.getState().openFiles.find((file) => file.worktreeId === id)!.filePath,
    setup.worktreeId
  )
  registerPostElectronShutdownCleanup(() => rm(createdPath, { force: true }))
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

test('Browser creation keeps an empty workspace after activation changes', async ({ orcaPage }) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const worktreeId = state.activeWorktreeId!
    const other = Object.values(state.worktreesByRepo)
      .flat()
      .find((row) => row.id !== worktreeId)!
    if (!state.tabsByWorktree[other.id]?.length) {
      state.createTab(other.id)
    }
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    window.__store!.setState((s) => ({
      groupsByWorktree: { ...s.groupsByWorktree, [worktreeId]: [] }
    }))
    return { worktreeId, other: other.id }
  })
  await worktreeRow(orcaPage, setup.worktreeId)
    .getByRole('button', { name: 'New tab', exact: true })
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.evaluate((id) => window.__store!.getState().setActiveWorktree(id), setup.other)
  await orcaPage
    .getByRole('menuitem', { name: /New Browser Tab/i })
    .first()
    .click({ force: true })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => window.__store!.getState().browserTabsByWorktree[id]?.length ?? 0,
        setup.worktreeId
      )
    )
    .toBe(1)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store!.getState().browserTabsByWorktree[id] ?? [],
      setup.other
    )
  ).toEqual([])
  await orcaPage.evaluate(
    (id) => window.__store!.getState().setActiveWorktree(id),
    setup.worktreeId
  )
  await expect(
    orcaPage.getByRole('combobox', { name: 'Search or enter URL', exact: true })
  ).toBeVisible()
})

test('a completed terminal creation does not close a reopened sidebar menu', async ({
  orcaPage
}) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const id = state.activeWorktreeId!
    const original = state.openNewTerminalTabInActiveWorkspace
    window.__store!.setState({
      openNewTerminalTabInActiveWorkspace: async (...args) => {
        await new Promise<void>((resolve) =>
          window.addEventListener('test-release-terminal', () => resolve(), { once: true })
        )
        return original(...args)
      }
    })
    return { id, before: state.tabsByWorktree[id]?.length ?? 0 }
  })
  const trigger = () =>
    worktreeRow(orcaPage, setup.id).getByRole('button', { name: 'New tab', exact: true })
  await trigger().click({ force: true })
  await orcaPage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeHidden()
  await trigger().click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.evaluate(() => window.dispatchEvent(new Event('test-release-terminal')))
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0,
        setup.id
      )
    )
    .toBe(setup.before + 1)
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await expect.poll(() => trigger().evaluate((node) => node === document.activeElement)).toBe(true)
})

test('page-wide create actions target the active split group', async ({ orcaPage }) => {
  const setup = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const id = state.activeWorktreeId!
    const source = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id][0].id
    const group = state.createEmptySplitGroup(id, source, 'right')!
    const tab = state.createTab(id, group, undefined, { activate: true })
    state.focusGroup(id, group)
    state.setActiveTab(tab.id)
    return { source, group }
  })
  const source = orcaPage.locator(`[data-tab-group-strip-id="${setup.source}"]`)
  const selected = orcaPage.locator(`[data-tab-group-strip-id="${setup.group}"]`)
  await expect(selected.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
  const sourceCount = await source.locator('[data-testid="sortable-tab"]').count()
  await (await tabCreateMenuTrigger(orcaPage)).click({ force: true })
  await orcaPage
    .getByRole('menuitem', { name: /New Terminal/i })
    .first()
    .click({ force: true })
  await expect(selected.locator('[data-testid="sortable-tab"]')).toHaveCount(2)
  await expect(source.locator('[data-testid="sortable-tab"]')).toHaveCount(sourceCount)
})

test('unmounting an open create menu restores its empty active workspace', async ({ orcaPage }) => {
  const id = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const id = state.activeWorktreeId!
    for (const tab of state.tabsByWorktree[id] ?? []) {
      state.closeTab(tab.id, { reason: 'user' })
    }
    return id
  })
  const tabs = () =>
    orcaPage.evaluate((id) => window.__store!.getState().tabsByWorktree[id]?.length ?? 0, id)
  await expect.poll(tabs).toBe(0)
  await worktreeRow(orcaPage, id)
    .getByRole('button', { name: 'New tab', exact: true })
    .click({ force: true })
  await expect(orcaPage.getByRole('menu')).toBeVisible()
  await orcaPage.evaluate(() => window.__store!.getState().setSidebarOpen(false))
  await expect(orcaPage.locator('[data-worktree-sidebar]')).toHaveCount(0)
  await expect.poll(tabs).toBe(1)
  await expect(orcaPage.locator('[data-testid="sortable-tab"]')).toHaveCount(1)
})
