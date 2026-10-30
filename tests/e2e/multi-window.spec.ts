import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId
} from './helpers/terminal'

test.skip(process.env.ORCA_E2E_WEB_CLIENT !== '1', 'Requires the bundled connected-client UI')
test.use({ orcaAppExtraArgs: process.platform === 'linux' ? ['--ozone-platform=x11'] : [] })

async function openWindow(app: ElectronApplication): Promise<Page> {
  const opened = app.waitForEvent('window')
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('new-window')
    if (!item) {
      throw new Error('File > New Window is missing')
    }
    item.click()
  })
  const page = await opened
  await expect(page.locator('[data-worktree-sidebar]')).toBeVisible({ timeout: 30_000 })
  return page
}

async function selectWorktree(page: Page, id: string): Promise<void> {
  await worktreeRowSurface(page, id).click({ force: true })
  await expect(page.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
    'data-rendered-active-worktree-id',
    id
  )
}

async function captureWindow(app: ElectronApplication, page: Page): Promise<Buffer> {
  const window = await app.browserWindow(page)
  await window.evaluate((window) => window.webContents.setBackgroundThrottling(false))
  const session = await page.context().newCDPSession(page)
  try {
    const result = await session.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(result.data, 'base64')
  } finally {
    await session.detach()
  }
}

async function typeAndReadOutput(
  page: Page,
  marker: string,
  command = `echo ${marker}`
): Promise<void> {
  await waitForActivePanePtyId(page, 30_000)
  await expect
    .poll(async () => (await getTerminalContent(page)).trim().length, { timeout: 30_000 })
    .toBeGreaterThan(0)
  const session = await page.context().newCDPSession(page)
  await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await focusActiveTerminalInput(page)
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  let lastOutput = ''
  try {
    await expect
      .poll(
        async () => {
          const output = await getTerminalContent(page)
          lastOutput = output
          return output.split(/\r?\n/).some((line) => line.trim() === marker)
        },
        { timeout: 15_000 }
      )
      .toBe(true)
  } catch (error) {
    throw new Error(
      `Expected shell output ${marker}; last terminal contents: ${JSON.stringify(lastOutput.slice(-2000))}`,
      { cause: error }
    )
  } finally {
    await session.detach()
  }
}

test('opens independent project windows from File and keeps terminals alive when another window closes', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'orca-multi-window-project-'))
  writeFileSync(
    path.join(folder, 'README.md'),
    'Second project for independent window validation.\n'
  )
  registerPostElectronShutdownCleanup(async () => rmSync(folder, { recursive: true, force: true }))
  const ids = await orcaPage.evaluate(async (folder) => {
    const store = window.__store
    if (!store) {
      throw new Error('Host store is unavailable')
    }
    const first = store.getState().repos[0]
    const firstWorktree = store
      .getState()
      .allWorktrees()
      .find((w) => w.repoId === first.id)
    if (!firstWorktree) {
      throw new Error('First project has no workspace')
    }
    const added = await window.api.repos.add({ path: folder, kind: 'folder' })
    if ('error' in added) {
      throw new Error(added.error)
    }
    await store.getState().fetchRepos({ runtimeEnvironmentId: null, throwOnError: true })
    await store.getState().fetchWorktrees(added.repo.id)
    const secondWorktree = store
      .getState()
      .allWorktrees()
      .find((w) => w.repoId === added.repo.id)
    if (!secondWorktree) {
      throw new Error('Second project has no workspace')
    }
    return {
      firstRepo: first.id,
      first: firstWorktree.id,
      secondRepo: added.repo.id,
      second: secondWorktree.id
    }
  }, folder)
  expect(
    await electronApp.evaluate(({ Menu }) =>
      Boolean(Menu.getApplicationMenu()?.getMenuItemById('new-window'))
    )
  ).toBe(false)
  if (process.env.ORCA_E2E_CAPTURE_VISUALS === '1') {
    await testInfo.attach('before-one-window', {
      body: await captureWindow(electronApp, orcaPage),
      contentType: 'image/png'
    })
  }
  await orcaPage.evaluate(() => window.api.settings.set({ experimentalMultiWindow: true }))
  await expect
    .poll(() =>
      electronApp.evaluate(({ Menu }) =>
        Boolean(Menu.getApplicationMenu()?.getMenuItemById('new-window'))
      )
    )
    .toBe(true)

  let first: Page | null = null
  let second: Page | null = null
  try {
    const pendingOffer = await orcaPage.evaluate(() =>
      window.api.mobile.getRuntimePairingUrl({ address: '127.0.0.1', reach: 'this-computer' })
    )
    if (!pendingOffer.available) {
      throw new Error('Could not create the unrelated pending offer')
    }
    first = await openWindow(electronApp)
    await selectWorktree(first, ids.first)
    second = await openWindow(electronApp)
    await selectWorktree(second, ids.second)
    await first.evaluate((repo) => {
      if (!window.__store) {
        throw new Error('Build the web client with VITE_EXPOSE_STORE=true')
      }
      window.__store.getState().setFilterRepoIds([repo])
    }, ids.firstRepo)
    await second.evaluate((repo) => {
      if (!window.__store) {
        throw new Error('Build the web client with VITE_EXPOSE_STORE=true')
      }
      window.__store.getState().setFilterRepoIds([repo])
    }, ids.secondRepo)
    await expect(worktreeRow(first, ids.first)).toBeVisible()
    await expect(worktreeRow(first, ids.second)).toHaveCount(0)
    await expect(worktreeRow(second, ids.second)).toBeVisible()
    await expect(worktreeRow(second, ids.first)).toHaveCount(0)
    expect(await orcaPage.evaluate(async () => (await window.api.ui.get()).filterRepoIds)).toEqual(
      []
    )

    await expect
      .poll(() => first!.evaluate(async () => (await window.api.ui.get()).filterRepoIds))
      .toEqual([ids.firstRepo])
    await first.evaluate(() => window.api.ui.recordFeatureInteraction('terminal-tabs'))
    expect(await first.evaluate(async () => (await window.api.ui.get()).filterRepoIds)).toEqual([
      ids.firstRepo
    ])
    const initializeShell =
      process.platform === 'win32'
        ? '$env:ORCA_WINDOW_CONTINUITY="ORCA_RELOADED_WINDOW_OK"; echo ORCA_FIRST_WINDOW_OK'
        : 'export ORCA_WINDOW_CONTINUITY=ORCA_RELOADED_WINDOW_OK; echo ORCA_FIRST_WINDOW_OK'
    await typeAndReadOutput(first, 'ORCA_FIRST_WINDOW_OK', initializeShell)
    await typeAndReadOutput(second, 'ORCA_SECOND_WINDOW_OK')
    const ptyBeforeReload = await waitForActivePanePtyId(first, 30_000)
    const tabBeforeReload = await first.evaluate(
      (worktree) => window.__store?.getState().activeTabIdByWorktree[worktree],
      ids.first
    )
    expect(tabBeforeReload).toBeTruthy()
    if (process.env.ORCA_E2E_CAPTURE_VISUALS === '1') {
      await testInfo.attach('after-first-project', {
        body: await captureWindow(electronApp, first),
        contentType: 'image/png'
      })
      await testInfo.attach('after-second-project', {
        body: await captureWindow(electronApp, second),
        contentType: 'image/png'
      })
    }

    await testInfo.attach('worker-navigation-before-reload', {
      body: JSON.stringify(
        await first.evaluate(() => {
          const sessions = Object.keys(localStorage)
            .filter((key) => key.startsWith('orca.web.workspaceSession'))
            .map((key) => {
              const session = JSON.parse(localStorage.getItem(key) ?? '{}')
              return {
                key,
                activeRepoId: session.activeRepoId,
                activeWorktreeId: session.activeWorktreeId
              }
            })
          return { sessions, activeWorktreeId: window.__store?.getState().activeWorktreeId }
        })
      ),
      contentType: 'application/json'
    })
    await first.reload()
    await expect(worktreeRow(first, ids.first)).toBeVisible({ timeout: 30_000 })
    await expect(worktreeRow(first, ids.second)).toHaveCount(0)
    await expect(first.locator('[data-rendered-active-worktree-id]')).toHaveAttribute(
      'data-rendered-active-worktree-id',
      ids.first
    )
    expect(await waitForActivePanePtyId(first, 30_000)).toBe(ptyBeforeReload)
    expect(
      await first.evaluate(
        (worktree) => window.__store?.getState().activeTabIdByWorktree[worktree],
        ids.first
      )
    ).toBe(tabBeforeReload)
    await typeAndReadOutput(
      first,
      'ORCA_RELOADED_WINDOW_OK',
      process.platform === 'win32'
        ? 'echo $env:ORCA_WINDOW_CONTINUITY'
        : 'echo "$ORCA_WINDOW_CONTINUITY"'
    )
    await first.close()
    first = null
    await typeAndReadOutput(second, 'ORCA_SURVIVING_WINDOW_OK')
    const remaining = await orcaPage.evaluate(() => window.api.mobile.listRuntimeAccessGrants())
    expect(remaining.grants).toHaveLength(3)
    expect(remaining.grants.some((grant) => grant.deviceId === pendingOffer.deviceId)).toBe(true)

    await electronApp.evaluate(({ BrowserWindow }) => {
      const host = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().startsWith('file:')
      )
      if (!host) {
        throw new Error('Host window is missing')
      }
      host.close()
    })
    await typeAndReadOutput(second, 'ORCA_HOST_CLOSED_WINDOW_OK')
  } finally {
    await first?.close()
    await second?.close()
  }
})
