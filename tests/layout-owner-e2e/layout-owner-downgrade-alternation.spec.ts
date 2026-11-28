// A profile the switch-on build wrote opens in the last shipped release, and survives alternating on, release, on, release.
import { existsSync, readFileSync } from 'node:fs'
import {
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { packagedExecutable, packagedExecutableMissing } from './helpers/packaged-old-orca'
import {
  countVisibleTerminalPanes,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { LAYOUT_OWNER_BUILD } from './helpers/layout-owner-build'

test.describe.configure({ mode: 'serial' })

type Shape = { titles: string[]; panes: number }

async function storeShape(page: Page, worktreeId: string): Promise<Shape> {
  await waitForPaneCount(page, 2, 30_000).catch(() => {})
  const titles = await page.evaluate(
    (id) =>
      (window.__store!.getState().tabsByWorktree[id] ?? []).map(
        (tab: { customTitle?: string | null; title: string }) => tab.customTitle || tab.title
      ),
    worktreeId
  )
  return { titles, panes: await countVisibleTerminalPanes(page) }
}

/** The release exposes no store: read what it draws. */
async function releaseShape(page: Page, expectedTitles: string[]): Promise<Shape> {
  for (const title of expectedTitles) {
    await expect(page.getByText(title, { exact: true }).first()).toBeVisible({ timeout: 60_000 })
  }
  const titles = await page.evaluate((expected) => {
    const seen = new Set(
      [...document.querySelectorAll('[role="tab"], [data-tab-id]')].map((node) =>
        (node.textContent ?? '').trim()
      )
    )
    return expected.filter((title) => [...seen].some((text) => text.includes(title)))
  }, expectedTitles)
  await expect
    .poll(() => page.locator('.xterm').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1)
    .catch(() => {})
  return { titles, panes: await page.locator('.xterm').count() }
}

test('a switch-on profile opens in the last release, and survives alternating builds', async (// oxlint-disable-next-line no-empty-pattern -- owns every launch
{}, testInfo) => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')
  test.skip(
    packagedExecutableMissing,
    'ORCA_CROSS_VERSION_PACKAGED_EXECUTABLE must point at a released Orca'
  )
  test.setTimeout(600_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'no seeded repo')

  const session = createRestartSession(testInfo)
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const releaseIsolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {},
    userDataDir: session.userDataDir
  })
  const launchRelease = (): Promise<ElectronApplication> =>
    electron.launch({
      executablePath: packagedExecutable!,
      args: [],
      env: {
        ...releaseIsolation.env,
        NODE_ENV: 'production',
        ORCA_BYPASS_SINGLE_INSTANCE_LOCK: '1',
        ORCA_E2E_HEADLESS: '1'
      }
    })
  const log: Record<string, Shape> = {}
  let app: ElectronApplication | undefined
  try {
    // 1. Switch-on build writes: two tabs, one split, one renamed.
    const first = await session.launch()
    app = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await splitActiveTerminalPane(first.page, 'vertical')
    await waitForPaneCount(first.page, 2, 30_000)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: restored layout-owner e2e; the value is read from the app under test and the assertion that follows checks its shape.
    const tabId = await first.page.evaluate(() => window.__store!.getState().activeTabId as string)
    await first.page.evaluate(
      ([id]) => window.__store!.getState().setTabCustomTitle(id, 'downgrade-probe-tab'),
      [tabId]
    )
    await expect
      .poll(() => storeShape(first.page, worktreeId))
      .toMatchObject({
        titles: ['downgrade-probe-tab'],
        panes: 2
      })
    log.onWrite = await storeShape(first.page, worktreeId)
    await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: session.userDataDir })
    app = undefined

    for (const round of [1, 2]) {
      // 2. The last release opens it.
      app = await launchRelease()
      const releasePage = await app.firstWindow({ timeout: 120_000 })
      await releasePage.waitForLoadState('domcontentloaded')
      log[`release${round}`] = await releaseShape(releasePage, ['downgrade-probe-tab'])
      await releasePage.screenshot({ path: testInfo.outputPath(`release${round}.png`) })
      expect(log[`release${round}`].titles).toEqual(['downgrade-probe-tab'])
      expect(log[`release${round}`].panes).toBeGreaterThanOrEqual(2)
      await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: session.userDataDir })
      app = undefined
      // 3. Back on the switch-on build.
      const again = await session.launch()
      app = again.app
      await waitForSessionReady(again.page)
      log[`on${round}`] = await storeShape(again.page, worktreeId)
      expect(log[`on${round}`]).toEqual(log.onWrite)
      await closeElectronAppForE2E(app, { cleanupDaemonsForUserDataDir: session.userDataDir })
      app = undefined
    }
  } finally {
    await testInfo.attach('downgrade-shapes', {
      body: JSON.stringify(log, null, 2),
      contentType: 'application/json'
    })
    console.log('[downgrade-probe]', JSON.stringify(log))
    await session.dispose(app)
  }
})
