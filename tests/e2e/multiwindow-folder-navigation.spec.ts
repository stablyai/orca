import { mkdirSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { openWorkspaceWindow } from './helpers/workspace-window'
import { worktreeRowSurface } from './worktree-row-locators'

test('windows navigate independently between a git project and a folder project', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const folder = testInfo.outputPath('folder-project')
  mkdirSync(folder, { recursive: true })
  const original = await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId!)
  const folderWorkspace = await orcaPage.evaluate(async (path) => {
    const repo = await window.__store!.getState().addNonGitFolder(path)
    if (!repo) {
      throw new Error('Folder project was not added')
    }
    return window.__store!.getState().worktreesByRepo[repo.id]![0]!.id
  }, folder)
  await worktreeRowSurface(orcaPage, original).click()
  const secondary = await openWorkspaceWindow(electronApp)
  await worktreeRowSurface(secondary, folderWorkspace).click()
  await expect
    .poll(() => secondary.evaluate(() => window.__store!.getState().activeWorktreeId))
    .toBe(folderWorkspace)
  expect(await orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(original)
  await worktreeRowSurface(secondary, original).click()
  await worktreeRowSurface(orcaPage, folderWorkspace).click()
  expect(await secondary.evaluate(() => window.__store!.getState().activeWorktreeId)).toBe(original)
  await secondary.screenshot({ path: testInfo.outputPath('independent-project-navigation.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
