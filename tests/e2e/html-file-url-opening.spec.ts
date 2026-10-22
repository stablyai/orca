import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { readDocPreviewRenderedText } from './helpers/paired-html-preview-inventory'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('opens HTML from Explorer as a preview and lets the user edit its source', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const name = 'default-preview.html'
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  const root = await orcaPage.evaluate(
    (id) => window.__store?.getState().getKnownWorktreeById(id)?.path,
    worktreeId
  )
  if (!root) {
    throw new Error('Active workspace missing')
  }
  const filePath = path.join(root, name)
  const url = pathToFileURL(filePath).href
  writeFileSync(filePath, '<title>HTML default</title><h1>Rendered by default</h1>')
  await orcaPage.evaluate(() => {
    window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
    const state = window.__store?.getState()
    state?.setRightSidebarOpen(true)
    state?.setRightSidebarTab('explorer')
  })
  await orcaPage.getByRole('button', { name: 'Refresh Explorer', exact: true }).click()
  const row = orcaPage.locator('[data-file-explorer-row]').filter({
    has: orcaPage.locator('[data-file-explorer-row-name]').getByText(name, { exact: true })
  })
  await expect(row).toBeVisible()
  await row.click()
  await expect
    .poll(() =>
      electronApp.evaluate(async ({ webContents }, fileUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fileUrl)
        return guest?.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
      }, url)
    )
    .toBe('Rendered by default')
  await electronApp.evaluate(async ({ webContents }, fileUrl) => {
    const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === fileUrl)
    await guest?.executeJavaScript(
      'const input = document.createElement("input"); input.id = "preview-state"; input.value = "Keep my input"; document.body.append(input)'
    )
  }, url)
  await row.click()
  await expect
    .poll(() =>
      electronApp.evaluate(async ({ webContents }, fileUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fileUrl)
        return guest?.executeJavaScript('document.querySelector("#preview-state")?.value ?? null')
      }, url)
    )
    .toBe('Keep my input')
  await orcaPage.screenshot({ path: testInfo.outputPath('html-default-preview.png') })
  await orcaPage.getByRole('button', { name: 'Open source file', exact: true }).click()
  await expect(orcaPage.locator('.editor-header-path')).toContainText(name)
  await expect(orcaPage.locator('.monaco-editor').first()).toBeVisible()
  await expect(orcaPage.locator('.monaco-editor').first()).toContainText('Rendered by default')
  await orcaPage.locator('.monaco-editor').first().click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.press('Enter')
  await orcaPage.keyboard.type('<p>Source updated</p>')
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect.poll(() => readFileSync(filePath, 'utf8')).toContain('<p>Source updated</p>')
  await row.click()
  await expect(
    orcaPage.getByRole('button', { name: 'Open source file', exact: true })
  ).toBeVisible()
  await expect
    .poll(() =>
      electronApp.evaluate(async ({ webContents }, fileUrl) => {
        const guest = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fileUrl)
        return guest?.executeJavaScript('document.body.textContent ?? ""')
      }, url)
    )
    .toContain('Source updated')
  const previewTab = orcaPage.locator('[data-tab-id]').filter({ hasText: 'HTML default' })
  await expect(previewTab).toHaveCount(1)
  await expect(previewTab).toBeVisible()
})

for (const inputKind of ['file URL', 'absolute path', 'linked path'] as const) {
  test(`opens a local HTML ${inputKind} with encoded characters from the new-tab menu`, async ({
    electronApp,
    orcaPage,
    testRepoPath
  }, testInfo) => {
    let directory = testRepoPath
    if (inputKind === 'linked path') {
      const target = testInfo.outputPath('external-source')
      mkdirSync(target, { recursive: true })
      directory = path.join(testRepoPath, 'linked-source')
      symlinkSync(target, directory, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const filePath = path.join(directory, 'report 中%20.html')
    writeFileSync(filePath, '<title>Local file URL</title><h1>Local HTML rendered</h1>')
    const url = pathToFileURL(filePath).href
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await orcaPage.getByRole('button', { name: 'New tab', exact: true }).first().click()
    const input = orcaPage.getByRole('combobox', {
      name: 'Search open tabs, history, files, URLs, agents…',
      exact: true
    })
    await input.fill(inputKind === 'file URL' ? url : filePath)
    await expect(orcaPage.getByRole('option', { name: /Open file/ })).toBeVisible()
    await input.press('Enter')
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, fileUrl) => {
          const guest = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === fileUrl)
          return guest?.executeJavaScript('document.querySelector("h1")?.textContent ?? null')
        }, url)
      )
      .toBe('Local HTML rendered')
    await expect(
      orcaPage.getByRole('button', { name: 'Open source file', exact: true })
    ).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('local-html-file-url.png') })
    await orcaPage.getByRole('button', { name: 'Open source file', exact: true }).click()
    const editor = orcaPage.locator('.monaco-editor').first()
    await expect(editor).toContainText('Local HTML rendered')
    await editor.click()
    await orcaPage.keyboard.press('ControlOrMeta+End')
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.type('<p>Source saved</p>')
    await orcaPage.keyboard.press('ControlOrMeta+S')
    await expect.poll(() => readFileSync(filePath, 'utf8')).toContain('<p>Source saved</p>')
  })
}

test('opens a pasted HTML file URL from a paired host and reloads its assets', async ({
  orcaPage,
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const documentDirectory = path.join(testRepoPath, 'file-url-docs')
  mkdirSync(documentDirectory, { recursive: true })
  const filePath = path.join(documentDirectory, 'report one.html')
  const assetPath = path.join(documentDirectory, 'report-data.js')
  writeFileSync(
    filePath,
    '<title>Remote file URL</title><h1>Remote HTML rendered</h1>' +
      '<p id="asset">pending</p><script src="./report-data.js"></script>'
  )
  writeFileSync(assetPath, 'document.querySelector("#asset").textContent = "host asset version 1"')
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const offer = await createRuntimeDesktopPairingOffer(orcaPage)
  const client = await launchPairedElectronClient(offer, testInfo, 'HTML file URL host')
  try {
    await expect
      .poll(
        () =>
          client.page.evaluate(
            (root) =>
              window.__store
                ?.getState()
                .allWorktrees()
                .some((worktree) => worktree.path === root),
            testRepoPath
          ),
        { timeout: 120_000 }
      )
      .toBe(true)
    const worktreeId = await client.page.evaluate(
      ({ root, environmentId }) => {
        window.localStorage.setItem('orca.browser.markup-draw-hint-seen', 'true')
        const state = window.__store?.getState()
        const worktree = state?.allWorktrees().find((candidate) => candidate.path === root)
        if (!state || !worktree) {
          throw new Error('Paired workspace missing')
        }
        state.setActiveWorktree(worktree.id, `runtime:${environmentId}`)
        state.createBrowserTab(worktree.id, 'data:text/html,', {
          browserRuntimeEnvironmentId: null,
          focusAddressBar: false,
          activate: true
        })
        return worktree.id
      },
      { root: testRepoPath, environmentId: client.environmentId }
    )
    await client.page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    const input = client.page.getByRole('combobox', {
      name: 'Search open tabs, history, files, URLs, agents…',
      exact: true
    })
    await input.fill(pathToFileURL(filePath).href)
    await expect(client.page.getByRole('option', { name: /Open file/ })).toBeVisible()
    await input.press('Enter')
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, 'h1'))
      .toBe('Remote HTML rendered')
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, '#asset'))
      .toBe('host asset version 1')
    const location = await client.page.evaluate(
      ({ worktreeId, filePath }) =>
        window.__store
          ?.getState()
          .browserTabsByWorktree[worktreeId]?.find((tab) => tab.docLocation?.filePath === filePath)
          ?.docLocation,
      { worktreeId, filePath }
    )
    expect(location).toEqual({ kind: 'workspace-doc', worktreeId, filePath })
    writeFileSync(
      assetPath,
      'document.querySelector("#asset").textContent = "host asset version 2"'
    )
    await client.page.getByRole('button', { name: 'Reload preview', exact: true }).click()
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, '#asset'))
      .toBe('host asset version 2')
    await client.page.evaluate(
      ({ worktreeId, filePath }) => {
        const state = window.__store?.getState()
        const workspace = state?.browserTabsByWorktree[worktreeId]?.find(
          (tab) => tab.docLocation?.filePath === filePath
        )
        if (!state || !workspace) {
          throw new Error('Document workspace missing')
        }
        state.createBrowserPage(workspace.id, 'data:text/html,', {
          browserRuntimeEnvironmentId: null,
          activate: true
        })
      },
      { worktreeId, filePath }
    )
    await expect(client.page.locator('[data-orca-browser-address-bar]:visible')).toBeFocused()
    await client.page.getByRole('button', { name: 'New tab', exact: true }).first().click()
    await input.fill(pathToFileURL(filePath).href)
    await expect(client.page.getByRole('option', { name: /Open file/ })).toBeVisible()
    await input.press('Enter')
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, '#asset'))
      .toBe('host asset version 2')
    await client.page.evaluate((worktreeId) => {
      window.__store?.getState().createBrowserTab(worktreeId, 'data:text/html,', {
        browserRuntimeEnvironmentId: null,
        focusAddressBar: false,
        activate: true
      })
    }, worktreeId)
    const address = client.page.locator('[data-orca-browser-address-bar]:visible')
    await address.fill(pathToFileURL(filePath).href)
    await address.press('Enter')
    await expect
      .poll(() => readDocPreviewRenderedText(client.page, '#asset'))
      .toBe('host asset version 2')
    expect(
      await client.page.evaluate(
        ({ worktreeId, filePath }) =>
          window.__store
            ?.getState()
            .browserTabsByWorktree[worktreeId]?.flatMap(
              (tab) => window.__store?.getState().browserPagesByWorkspace[tab.id] ?? []
            )
            .filter((page) => page.docLocation?.filePath === filePath).length,
        { worktreeId, filePath }
      )
    ).toBe(1)
    await client.page.screenshot({ path: testInfo.outputPath('remote-html-file-url.png') })
  } catch (error) {
    await testInfo.attach('paired-client-failure', {
      body: await client.page.screenshot(),
      contentType: 'image/png'
    })
    throw error
  } finally {
    await client.dispose()
  }
})
