import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { commitRepository, configureFixtureGit } from './helpers/plugin-git-fixture'
import {
  commitFixtureChange,
  PLUGINS,
  publishCatalog,
  writePlugin
} from './helpers/plugin-update-catalog-fixture'

// Why: install, catalog refresh and the update pass all fetch Git; a loaded runner outlasts 10s.
const GIT_STEP = { timeout: 90_000 }

/** Runs an automatic update pass now (turning the policy back on starts one) and waits for it. */
async function runAutoUpdatePass(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const passed = new Promise<void>((resolve) => {
      const stop = window.api.plugins.onAutoUpdateChanged(() => {
        stop()
        resolve()
      })
    })
    const state = window.__store?.getState()
    await state?.updateSettings({ pluginUpdatePolicy: 'manual' })
    await state?.updateSettings({ pluginUpdatePolicy: 'auto' })
    await passed
  })
}

function openPluginsSettings(page: Page): Promise<void> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    state?.openSettingsTarget({ pane: 'plugins', repoId: null })
    state?.openSettingsPage()
  })
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('tells once per version when an automatic update waits for review, and Review never approves', async ({}, testInfo) => {
  // Why: two launches, two Git-backed installs and four update passes against local git.
  test.setTimeout(300_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-update-review-toast-'))
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(repositories, { recursive: true })
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, ['orca-plugins', ...PLUGINS])
  for (const id of PLUGINS) {
    const repository = join(repositories, `${id}.git`)
    await writePlugin(repository, id, '1.0.0')
    await commitRepository(repository, gitEnvironment)
  }
  const marketplace = join(repositories, 'orca-plugins.git')
  await mkdir(marketplace, { recursive: true })
  await publishCatalog(repositories, gitEnvironment, '1.0.0')
  await commitRepository(marketplace, gitEnvironment)
  const publish = async (ids: readonly string[], version: string): Promise<void> => {
    for (const id of ids) {
      const repository = join(repositories, `${id}.git`)
      await writePlugin(repository, id, version)
      await commitFixtureChange(repository, gitEnvironment, `release ${version}`)
    }
    await publishCatalog(repositories, gitEnvironment, version)
    await commitFixtureChange(marketplace, gitEnvironment, `publish ${version}`)
  }
  const session = createRestartSession(testInfo, {
    ...gitEnvironment,
    ORCA_BACKGROUND_LAUNCH: '1',
    ORCA_PLUGIN_AUTO_UPDATE: '1'
  })
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    let page = launched.page
    await openPluginsSettings(page)
    // Content-only 1.0.0 installs and turns on in one click, so it is an approved predecessor.
    for (const id of PLUGINS) {
      await page.locator(`[data-plugin-key="stablyai.${id}"] [data-plugin-row-name]`).click()
      await page.getByRole('button', { name: /^Install / }).click()
      await expect(page.getByRole('button', { name: /^Use now: / })).toBeVisible(GIT_STEP)
      await page.getByRole('article').getByRole('button', { name: 'Plugins', exact: true }).click()
    }
    const versions = (): Promise<Record<string, string | undefined>> =>
      page.evaluate(async () =>
        Object.fromEntries(
          (await window.api.plugins.list()).map((plugin) => [plugin.pluginKey, plugin.version])
        )
      )
    const installedBefore = await versions()

    // Both grow access (content-only → full access): one grouped toast, nothing installed.
    await publish(PLUGINS, '2.0.0')
    await runAutoUpdatePass(page)
    const grouped = page.locator('[data-sonner-toast]', {
      hasText: '2 plugin updates need your review'
    })
    await expect(grouped).toBeVisible(GIT_STEP)
    // Each plugin with its publisher and what it adds, approvable in place.
    await expect(grouped.locator('[data-plugin-update-toast]')).toHaveCount(2)
    await expect(grouped).toContainText('Official · stablyai')
    await expect(grouped.getByRole('button', { name: 'Approve & update all' })).toBeVisible()
    await page.screenshot({
      path: testInfo.outputPath('grouped-toast.png'),
      animations: 'disabled'
    })
    // Details opens the grouped review over the app, without going to Settings.
    await grouped.getByRole('button', { name: 'Details', exact: true }).dispatchEvent('click')
    const groupedReview = page.getByRole('dialog', { name: 'Review 2 updates', exact: true })
    await expect(groupedReview.locator('[data-plugin-update-review]')).toHaveCount(2, GIT_STEP)
    await expect(grouped).toBeHidden()
    await page.screenshot({ path: testInfo.outputPath('grouped-review-dialog.png') })
    await groupedReview.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(groupedReview).toBeHidden()
    expect(await versions()).toEqual(installedBefore)

    // Same versions on a later pass and after a restart: told already, so no toast.
    await runAutoUpdatePass(page)
    await session.close(launched.app)
    launched = await session.launch()
    page = launched.page
    await runAutoUpdatePass(page)
    // The pass has finished, so main has nothing left to tell for these versions.
    expect(await page.evaluate(() => window.api.plugins.takeUpdateReviewNotices())).toEqual([])
    await expect(page.locator('[data-sonner-toast]', { hasText: 'need your review' })).toHaveCount(
      0
    )
    await expect(page.locator('[data-sonner-toast]', { hasText: 'wants more access' })).toHaveCount(
      0
    )

    // A newer version of one plugin is told again, by name and Orca-derived publisher.
    await publish([PLUGINS[0]], '3.0.0')
    await runAutoUpdatePass(page)
    const single = page.locator('[data-sonner-toast]', {
      hasText: 'Review Notes 3.0.0 wants more access'
    })
    await expect(single).toBeVisible(GIT_STEP)
    await expect(single).toContainText('Official · stablyai')
    await page.screenshot({ path: testInfo.outputPath('single-toast.png'), animations: 'disabled' })
    expect(await versions()).toEqual(installedBefore)
    // Approving in the toast installs exactly what it showed, with no trip to Settings.
    await single
      .getByRole('button', { name: 'Approve & update', exact: true })
      .dispatchEvent('click')
    await expect(single).toBeHidden(GIT_STEP)
    await expect(
      page.locator('[data-sonner-toast]', { hasText: 'Review Notes updated to 3.0.0' })
    ).toBeVisible(GIT_STEP)
    expect((await versions())[`stablyai.${PLUGINS[0]}`]).toBe('3.0.0')
    // Approved exactly the reviewed bytes, so nothing waits on the plugin's page.
    expect(
      await page.evaluate(
        async (key) =>
          (await window.api.plugins.list()).find((plugin) => plugin.pluginKey === key)
            ?.needsReconsent,
        `stablyai.${PLUGINS[0]}`
      )
    ).toBe(false)
  } finally {
    await session.dispose(launched?.app)
    await rm(root, { recursive: true, force: true })
  }
})
