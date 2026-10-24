/**
 * Invariant: opening a file Orca can't highlight suggests the catalog plugin whose release lists
 * its extension; View plugin opens the reviewed preview and never installs.
 */

import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/plugin-schema-field-docs'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { hashPluginTree } from '../../src/main/plugins/plugin-content-hash'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { commitRepository, configureFixtureGit, headCommit } from './helpers/plugin-git-fixture'
import { openRepoFile } from './helpers/plugin-smoke'

const PLUGIN = 'orca-gleam-syntax'
const PLUGIN_KEY = `stablyai.${PLUGIN}`

async function createCatalogFixture(root: string) {
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, ['orca-plugins', PLUGIN])

  const plugin = join(repositories, `${PLUGIN}.git`)
  await cp(join(process.cwd(), 'examples', 'plugins', PLUGIN), plugin, { recursive: true })
  // Why before init: the release vouches for the plugin files, not the repository metadata.
  const hashed = await hashPluginTree(plugin)
  if (!hashed.ok) {
    throw new Error(hashed.error)
  }
  await commitRepository(plugin, gitEnvironment)

  const catalog = join(repositories, 'orca-plugins.git')
  await mkdir(catalog, { recursive: true })
  await writeFile(
    join(catalog, 'orca-catalog.json'),
    JSON.stringify({
      catalogVersion: 2,
      name: 'Orca Plugins',
      owner: 'stablyai',
      plugins: [
        {
          id: PLUGIN_KEY,
          source: { kind: 'git', url: `https://github.com/stablyai/${PLUGIN}.git`, ref: 'v1.0.0' },
          releases: [
            {
              version: '1.0.0',
              commit: await headCommit(plugin, gitEnvironment),
              contentHash: hashed.hash,
              execution: 'data',
              minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
              name: 'Gleam',
              types: ['syntax'],
              fileTypes: ['gleam']
            }
          ]
        }
      ]
    })
  )
  await commitRepository(catalog, gitEnvironment)

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'main.gleam'), 'pub fn main() { Nil }\n')
  await commitRepository(workspace, gitEnvironment)
  // Why realpath: Orca registers the repository by its resolved path, as macOS /var is a link.
  return { gitEnvironment, workspace: await realpath(workspace) }
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('suggests a catalog plugin for an unknown file and never installs it', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-file-type-suggestion-e2e-'))
  const fixture = await createCatalogFixture(root)
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const page = launched.page
    await page.evaluate(async () => {
      const settings = await window.api.settings.set({ pluginSystemEnabled: true })
      window.__store?.setState({ settings })
      await window.api.plugins.refreshMarketplaces?.({})
    })
    await expect
      .poll(
        () =>
          page.evaluate(async () =>
            (await window.api.plugins.listMarketplacePlugins()).map((entry) => entry.pluginKey)
          ),
        { timeout: 60_000 }
      )
      .toContain(PLUGIN_KEY)

    await attachRepoAndOpenTerminal(page, fixture.workspace)
    await openRepoFile(page, fixture.workspace, 'main.gleam')
    const banner = page.getByText('A plugin can open .gleam files: Gleam')
    await expect(banner).toBeVisible({ timeout: 15_000 })

    await page.getByRole('button', { name: 'View plugin' }).click()
    const preview = page.getByRole('dialog', { name: 'Gleam' })
    await expect(preview).toBeVisible({ timeout: 30_000 })
    await expect(preview).toContainText('Official · stablyai')
    await expect(preview).toContainText('1 syntax')
    await preview.getByRole('button', { name: 'Cancel' }).click()
    expect(
      await page.evaluate(async () =>
        (await window.api.plugins.list()).map((entry) => entry.pluginKey)
      )
    ).not.toContain(PLUGIN_KEY)

    await page.evaluate(() => window.__store?.getState().closeSettingsPage())
    await page.getByRole('button', { name: "Don't suggest for .gleam" }).click()
    await expect(banner).toBeHidden()
    await expect
      .poll(() =>
        page.evaluate(() => window.__store?.getState().settings?.pluginDismissedFileTypes)
      )
      .toEqual(['gleam'])
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
