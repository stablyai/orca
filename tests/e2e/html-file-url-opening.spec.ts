import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient
} from './helpers/paired-electron-client'
import { readDocPreviewRenderedText } from './helpers/paired-html-preview-inventory'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('opens a local HTML file URL with encoded characters from the new-tab menu', async ({
  electronApp,
  orcaPage,
  testRepoPath
}, testInfo) => {
  const filePath = path.join(testRepoPath, 'report 中%20.html')
  writeFileSync(filePath, '<title>Local file URL</title><h1>Local HTML rendered</h1>')
  const url = pathToFileURL(filePath).href
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).first().click()
  const input = orcaPage.getByRole('combobox', {
    name: 'Search open tabs, history, files, URLs, agents…',
    exact: true
  })
  await input.fill(url)
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
  expect(
    await orcaPage.evaluate(
      ({ worktreeId, url }) =>
        window.__store
          ?.getState()
          .browserTabsByWorktree[worktreeId]?.some((tab) => tab.url === url && !tab.docLocation),
      { worktreeId, url }
    )
  ).toBe(true)
  await orcaPage.screenshot({ path: testInfo.outputPath('local-html-file-url.png') })
})

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
