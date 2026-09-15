import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { worktreeRowSurface } from './worktree-row-locators'
import { openWorkspaceWindow } from './helpers/workspace-window'

async function beginDrag(page: Page, tab: Locator, target: { x: number; y: number }) {
  const rect = (await tab.boundingBox())!
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2)
  await page.mouse.down()
  await page.mouse.move(rect.x + rect.width / 2 + 12, rect.y + rect.height / 2, { steps: 3 })
  await page.mouse.move(target.x, target.y, { steps: 10 })
}

test('context, keyboard menus and drag preview/cancel/commit retain real pane surfaces', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const errors: string[] = []
  orcaPage.on('pageerror', (error) => errors.push(error.message))
  await expect(orcaPage.locator('[data-project-accent]')).toHaveCount(0)
  const folder = testInfo.outputPath('same-name-folder')
  mkdirSync(folder, { recursive: true })
  const filePath = path.join(folder, 'draft.md')
  writeFileSync(filePath, '# Pane context draft\n')
  const fixture = await orcaPage.evaluate(
    async ({ folder, filePath }) => {
      const state = window.__store!.getState()
      const original = state.activeWorktreeId!
      const terminal = state.tabsByWorktree[original]?.[0] ?? state.createTab(original)
      const repo = await state.addNonGitFolder(folder)
      await state.updateRepo(repo!.id, { badgeColor: '#8b5cf6' })
      const folderId = window.__store!.getState().worktreesByRepo[repo!.id]![0].id
      state.openFile({
        worktreeId: folderId,
        filePath,
        relativePath: 'draft.md',
        language: 'markdown',
        mode: 'edit'
      })
      const current = window.__store!.getState()
      const name = 'A long identical project name with enough detail to overflow narrow panes'
      window.__store!.setState({
        projects: current.projects.map((project) => ({ ...project, displayName: name })),
        repos: current.repos.map((project) => ({ ...project, displayName: name }))
      })
      return { original, folderId, repoId: repo!.id, terminalId: terminal.id }
    },
    { folder, filePath }
  )
  await worktreeRowSurface(orcaPage, fixture.folderId).click()
  const tab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'draft.md' })
  await tab.click()
  await expect(orcaPage.locator('[data-project-label]')).toHaveCount(2)
  await expect(
    orcaPage.locator('[data-project-label] [data-project-accent="#8b5cf6"]')
  ).toHaveCount(1)
  await expect(orcaPage.locator('[data-project-accent="#8b5cf6"]')).toHaveCount(3)
  await expect(orcaPage.locator('[data-pane-context]')).toHaveAttribute(
    'aria-label',
    /This computer/
  )
  const editor = orcaPage.locator('.rich-markdown-editor')
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type('PANE DRAG UNSAVED')
  const editorHandle = await editor.elementHandle()
  const body = (await orcaPage.locator('[data-tab-group-body-id]').boundingBox())!
  const edge = { x: body.x + body.width - 10, y: body.y + body.height / 2 }
  const initial = await orcaPage.evaluate(() =>
    JSON.stringify(window.__store!.getState().windowPaneLayout)
  )
  await beginDrag(orcaPage, tab, edge)
  await expect(orcaPage.getByText(/Split right of/)).toBeVisible()
  expect(
    await orcaPage.evaluate(() => JSON.stringify(window.__store!.getState().windowPaneLayout))
  ).toBe(initial)
  await orcaPage.screenshot({ path: testInfo.outputPath('drag-preview.png') })
  await orcaPage.keyboard.press('Escape')
  await orcaPage.mouse.up()
  expect(
    await orcaPage.evaluate(() => JSON.stringify(window.__store!.getState().windowPaneLayout))
  ).toBe(initial)
  await beginDrag(orcaPage, tab, edge)
  await expect(orcaPage.getByText(/Split right of/)).toBeVisible()
  await orcaPage.mouse.up()
  const panes = orcaPage.getByRole('region', { name: 'Workspace pane', exact: true })
  await expect(panes).toHaveCount(2)
  await expect(editor).toContainText('PANE DRAG UNSAVED')
  expect(await editorHandle!.evaluate((element) => element.isConnected)).toBe(true)
  await expect(panes.nth(1).getByText('Active pane', { exact: true })).toBeVisible()
  for (const mode of ['light', 'dark'] as const) {
    await orcaPage.evaluate(
      (mode) => window.__store!.getState().updateSettings({ theme: mode }),
      mode
    )
    await orcaPage.waitForFunction(
      (mode) => document.documentElement.classList.contains(mode),
      mode
    )
    await orcaPage.screenshot({ path: testInfo.outputPath(`context-${mode}.png`) })
  }
  const trigger = panes.nth(1).getByRole('button', { name: 'Window actions' })
  await trigger.focus()
  await orcaPage.keyboard.press('Enter')
  await expect(orcaPage.getByRole('menuitem', { name: 'Move to Pane', exact: true })).toBeVisible()
  await orcaPage.getByRole('menuitem', { name: 'Move to Pane', exact: true }).hover()
  await orcaPage.getByRole('menuitem').filter({ hasText: '(1)' }).click()
  await expect(panes.nth(0).locator('[data-tab-id]')).toHaveCount(2)
  await expect(editor).toContainText('PANE DRAG UNSAVED')
  await panes.nth(0).locator('[data-tab-id]').filter({ hasText: 'draft.md' }).click()
  await panes.nth(0).getByRole('button', { name: 'New tab', exact: true }).click()
  await orcaPage
    .getByRole('menuitem', { name: /^New Terminal/ })
    .first()
    .click()
  await orcaPage.evaluate(() => window.__store!.getState().setWindowPaneRatio('', 0.15))
  const mixedTabs = panes.nth(0).locator('[data-tab-id]')
  await expect(mixedTabs).toHaveCount(3)
  const firstBounds = (await mixedTabs.nth(0).boundingBox())!
  const secondBounds = (await mixedTabs.nth(1).boundingBox())!
  expect(firstBounds.x + firstBounds.width).toBeLessThanOrEqual(secondBounds.x + 1)
  for (const item of await mixedTabs.all()) {
    await item.click()
    await expect(item).toHaveAttribute('data-active', 'true')
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('narrow-mixed-project-tabs.png') })
  await orcaPage.evaluate(
    (repoId) => window.__store!.getState().updateRepo(repoId, { badgeColor: '#737373' }),
    fixture.repoId
  )
  await expect(orcaPage.locator('[data-project-accent]')).toHaveCount(0)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
  expect(errors).toEqual([])
})

test('outside and cross-window drags use ready native destinations and preserve the running session', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const worktreeId = await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId!)
  await worktreeRowSurface(orcaPage, worktreeId).click()
  await expect(orcaPage.locator('[data-pane-context]')).toBeVisible()
  await orcaPage.evaluate(async (worktreeId) => {
    const state = window.__store!.getState()
    const repoId = state.getKnownWorktreeById(worktreeId, 'local')!.repoId
    await state.updateRepo(repoId, { badgeColor: '#14b8a6' })
  }, worktreeId)
  const source = await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    const layout = state.windowPaneLayout!
    const pane = layout.panes[layout.activePaneId]
    const view = layout.views[pane.selectedViewId!]
    return { viewId: view.id, worktreeId: view.worktreeId, terminalId: view.entityId }
  })
  const secondary = await openWorkspaceWindow(electronApp)
  await worktreeRowSurface(secondary, source.worktreeId).click()
  await expect(secondary.locator('[data-pane-context]')).toHaveAttribute(
    'aria-label',
    /This computer/
  )
  await expect(
    secondary.locator('[data-pane-context] [data-project-accent="#14b8a6"]')
  ).toHaveCount(1)
  const sourceId = await orcaPage.evaluate(() => window.orcaWorkspaceViews!.ready())
  const destinationId = await secondary.evaluate(() => window.orcaWorkspaceViews!.ready())
  await electronApp.evaluate(
    ({ BrowserWindow }, { sourceId, destinationId }) => {
      BrowserWindow.fromId(sourceId)!.setBounds({ x: 0, y: 0, width: 1280, height: 800 })
      BrowserWindow.fromId(destinationId)!.setBounds({ x: 1500, y: 0, width: 1280, height: 800 })
    },
    { sourceId, destinationId }
  )
  const targetBody = (await secondary.locator('[data-tab-group-body-id]').boundingBox())!
  const target = await electronApp.evaluate(
    ({ BrowserWindow }, { sourceId, destinationId, body }) => {
      const from = BrowserWindow.fromId(sourceId)!.getContentBounds()
      const to = BrowserWindow.fromId(destinationId)!.getContentBounds()
      const sourceZoom = BrowserWindow.fromId(sourceId)!.webContents.getZoomFactor()
      const destinationZoom = BrowserWindow.fromId(destinationId)!.webContents.getZoomFactor()
      return {
        x: (to.x - from.x + (body.x + body.width - 10) * destinationZoom) / sourceZoom,
        y: (to.y - from.y + (body.y + body.height / 2) * destinationZoom) / sourceZoom
      }
    },
    { sourceId, destinationId, body: targetBody }
  )
  expect(
    await orcaPage.evaluate((point) => window.orcaWorkspaceViews!.locateDrop(point), target)
  ).toMatchObject({ destinationId, target: { zone: 'right' } })
  await beginDrag(orcaPage, orcaPage.locator(`[data-tab-id="${source.terminalId}"]`), target)
  await expect(orcaPage.getByText(/Split right of.*in/)).toBeVisible()
  await orcaPage.mouse.up()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (viewId) => !!window.__store!.getState().windowPaneLayout!.views[viewId],
        source.viewId
      )
    )
    .toBe(false)
  await expect(secondary.getByRole('region', { name: 'Workspace pane', exact: true })).toHaveCount(
    2
  )
  await secondary.screenshot({ path: testInfo.outputPath('cross-window-drag.png') })
  const active = secondary.locator('section[data-current="true"]')
  await beginDrag(secondary, active.locator('[data-tab-id]'), { x: -2000, y: 300 })
  await expect(secondary.getByText('Move to New Window', { exact: true })).toBeVisible()
  const newWindow = electronApp.waitForEvent('window')
  await secondary.mouse.up()
  const detached = await newWindow
  await detached.waitForFunction(() => window.__store?.getState().workspaceSessionReady)
  await expect
    .poll(() =>
      secondary.evaluate(
        () =>
          Object.values(window.__store!.getState().windowPaneLayout!.panes).filter(
            (pane) => pane.viewIds.length
          ).length
      )
    )
    .toBe(1)
  await expect(detached.locator('[data-pane-context]').first()).toHaveAttribute(
    'aria-label',
    /This computer/
  )
  await expect(detached.locator('[data-pane-context] [data-project-accent="#14b8a6"]')).toHaveCount(
    1
  )
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
