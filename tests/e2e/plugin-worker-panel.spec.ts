/**
 * Invariant: a panel and its plugin's own worker are one program. The panel's first
 * `plugin.request` starts the worker, a setting the person changes reaches it, a
 * `persist: 'storage'` atom is the worker's `storage`, the worker's post reaches `plugin.on`, and
 * the declared settings show under the plugin in Settings.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { disablePluginSystem, enableDevPlugins } from './helpers/plugin-smoke'
import { ISOLATED_FRAMES_E2E } from './helpers/plugin-frame-guest'

test.use(ISOLATED_FRAMES_E2E)

async function openPanel(page: Page, title: string): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store?.getState()
    if (store && !store.rightSidebarOpen) {
      store.toggleRightSidebar()
    }
    await window.api.plugins.refresh()
  })
  const button = page.getByRole('button', { name: title })
  await expect(button).toBeVisible({ timeout: 15_000 })
  await button.click()
}

test('a panel and its own worker: requests, posts, a storage atom, settings', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'orca-worker-panel-'))
  const pluginRoot = join(tempRoot, 'hello-worker-panel')
  try {
    await cp(join(process.cwd(), 'examples', 'plugins', 'hello-worker-panel'), pluginRoot, {
      recursive: true
    })
    await enableDevPlugins(orcaPage, [pluginRoot])
    await openPanel(orcaPage, 'Hello Worker Panel')

    await expect(orcaPage.getByRole('heading', { name: 'Tasks' })).toBeVisible({ timeout: 15_000 })
    await expect(orcaPage.getByText('Edit src/panel.tsx and save')).toBeVisible()
    await expect(orcaPage.getByText('1 open')).toBeVisible()
    // The worker answered the panel's first plugin.request from the `suggestions` default.
    const draft = orcaPage.getByPlaceholder('New task')
    await expect(draft).toHaveValue('Write a test', { timeout: 15_000 })
    await draft.fill('Ship without a build')
    await orcaPage.getByRole('button', { name: 'Add task' }).click()
    await expect(orcaPage.getByText('Ship without a build')).toBeVisible()
    await expect(orcaPage.getByText('2 open')).toBeVisible()

    // A setting the person changes reaches the worker's next answer.
    await orcaPage.evaluate(async () => {
      const plugin = (await window.api.plugins.list()).find(
        (entry) => entry.name === 'Hello Worker Panel'
      )
      const written = await window.api.plugins.setSetting?.({
        pluginKey: plugin?.pluginKey ?? '',
        key: 'suggestions',
        value: 'Ship the bridge'
      })
      if (!written?.ok) {
        throw new Error(`setSetting failed: ${JSON.stringify(written)}`)
      }
    })
    await orcaPage.getByRole('button', { name: 'Suggest' }).click()
    await expect(draft).toHaveValue('Ship the bridge')

    // Finishing the list: the atom lands in storage, the worker sees it and posts back.
    await orcaPage.getByText('Edit src/panel.tsx and save').click()
    await orcaPage.getByText('Ship without a build').click()
    await expect(orcaPage.getByText('All 3 done!')).toBeVisible({ timeout: 15_000 })

    // The declared settings show under the plugin in Orca's Settings, with the person's value.
    const pluginKey = await orcaPage.evaluate(
      async () =>
        (await window.api.plugins.list()).find((entry) => entry.name === 'Hello Worker Panel')
          ?.pluginKey
    )
    await electronApp.evaluate(({ app }, link) => {
      app.emit('open-url', { preventDefault: () => undefined }, link)
    }, `orca://plugins/${pluginKey}`)
    const article = orcaPage.getByRole('article')
    await expect(article.locator('#plugin-detail-heading')).toContainText('Hello Worker Panel', {
      timeout: 30_000
    })
    await expect(article.getByText('Celebrate finished lists')).toBeVisible()
    await expect(article.getByLabel('Task ideas')).toHaveValue('Ship the bridge')
    await expect(article.getByRole('switch', { name: 'Celebrate finished lists' })).toBeChecked()
    await testInfo.attach('plugin-settings', {
      body: await article.screenshot(),
      contentType: 'image/png'
    })
  } finally {
    await disablePluginSystem(orcaPage).catch(() => undefined)
    await rm(tempRoot, { recursive: true, force: true })
  }
})
