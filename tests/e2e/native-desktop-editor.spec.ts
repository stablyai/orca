import path from 'node:path'
import { readFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { peerNativeWindow } from './helpers/native-desktop-window'

test('a peer closing its clean editor leaves another window draft open and saveable', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  await explorer
    .locator('[data-file-explorer-row]')
    .filter({
      has: orcaPage.locator('[data-file-explorer-row-name]').getByText('README.md', { exact: true })
    })
    .click()
  await expect(orcaPage.locator('.rich-markdown-editor')).toBeVisible()
  const fileId = await orcaPage.evaluate(
    () => window.__store!.getState().openFiles.find((file) => file.relativePath === 'README.md')!.id
  )
  await expect
    .poll(() =>
      orcaPage.evaluate(async (id) => {
        const session = await window.api.session.get()
        return Object.values(session.openFilesByWorktree ?? {})
          .flat()
          .some((file) => file.filePath === id)
      }, fileId)
    )
    .toBe(true)
  const peer = await peerNativeWindow(electronApp, orcaPage)
  await peer.waitForFunction(
    (id) => window.__store!.getState().openFiles.some((file) => file.id === id && !file.isDirty),
    fileId
  )
  const editor = orcaPage.locator('.rich-markdown-editor')
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type('Unsaved draft survives peer close')
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (id) => window.__store!.getState().openFiles.find((file) => file.id === id)?.isDirty,
        fileId
      )
    )
    .toBe(true)
  await peer.evaluate(async (id) => {
    await window.__store!.getState().closeFile(id)
  }, fileId)
  await expect
    .poll(() =>
      peer.evaluate(
        (id) => window.__store!.getState().openFiles.some((file) => file.id === id),
        fileId
      )
    )
    .toBe(false)
  await expect(editor).toContainText('Unsaved draft survives peer close')
  await expect
    .poll(() =>
      orcaPage.evaluate((id) => {
        const state = window.__store!.getState()
        return (
          state.openFiles.some((file) => file.id === id) &&
          Object.values(state.unifiedTabsByWorktree)
            .flat()
            .some((tab) => tab.entityId === id)
        )
      }, fileId)
    )
    .toBe(true)
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect
    .poll(() => readFileSync(path.join(testRepoPath, 'README.md'), 'utf8'))
    .toContain('Unsaved draft survives peer close')
  await orcaPage.screenshot({ path: testInfo.outputPath('native-peer-draft-preserved.png') })
})

test('an additional native window saves an edited file after the first window closes', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)
  const known = new Set(electronApp.windows())
  expect(await orcaPage.evaluate(() => window.api.ui.openRuntimeClientWindow())).toEqual({
    ok: true
  })
  await expect
    .poll(() =>
      electronApp
        .windows()
        .some((page) => !known.has(page) && /\/index\.html(?:[?#]|$)/.test(page.url()))
    )
    .toBe(true)
  const page = electronApp
    .windows()
    .find((candidate) => !known.has(candidate) && /\/index\.html(?:[?#]|$)/.test(candidate.url()))
  if (!page) {
    throw new Error('Missing additional native window')
  }
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 30_000 })
  await waitForSessionReady(page)
  const first = await electronApp.browserWindow(orcaPage)
  await first.evaluate((window) => window.close())
  await expect.poll(() => orcaPage.isClosed()).toBe(true)
  const explorer = page.locator('[data-orca-explorer-shell]')
  const row = explorer.locator('[data-file-explorer-row]').filter({
    has: page.locator('[data-file-explorer-row-name]').getByText('README.md', { exact: true })
  })
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()
  const editor = page.locator('.rich-markdown-editor')
  await expect(editor).toContainText('Orca E2E Test Repo', { timeout: 30_000 })
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Native desktop editor saved')
  await page.keyboard.press('ControlOrMeta+S')
  await expect
    .poll(() => readFileSync(path.join(testRepoPath, 'README.md'), 'utf8'))
    .toContain('Native desktop editor saved')
  const screenshot = testInfo.outputPath('native-desktop-editor.png')
  await page.screenshot({ path: screenshot })
  await testInfo.attach('native-desktop-editor', { path: screenshot, contentType: 'image/png' })
})
