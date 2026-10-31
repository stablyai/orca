// Use production Git paths from a fresh profile for official marketplace discovery and Phase 1 language and VM recipe setup.

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { commitRepository, configureFixtureGit } from './helpers/plugin-git-fixture'
import {
  FIXTURE_LANGUAGE_PLUGIN,
  writeFixtureLanguagePlugin
} from './helpers/plugin-language-pack-fixture'

const FIXTURE_REPOSITORIES = [
  'orca-plugins',
  FIXTURE_LANGUAGE_PLUGIN.repository,
  'orca-multipass-recipes'
]

type MarketplaceFixture = {
  root: string
  home: string
  gitEnvironment: Record<string, string>
}

async function copyLaunchPlugin(
  repositories: string,
  repositoryName: string,
  launchDirectory: string,
  gitEnvironment: Record<string, string>
): Promise<void> {
  const repository = join(repositories, `${repositoryName}.git`)
  await cp(join(process.cwd(), 'resources', 'plugins', 'launch', launchDirectory), repository, {
    recursive: true
  })
  await commitRepository(repository, gitEnvironment)
}

async function createMarketplaceFixture(): Promise<MarketplaceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-marketplace-e2e-'))
  const repositories = join(root, 'repositories')
  const home = join(root, 'home')
  await mkdir(repositories, { recursive: true })
  await mkdir(home, { recursive: true })
  const gitEnvironment = await configureFixtureGit(home, repositories, FIXTURE_REPOSITORIES)
  const languageRepository = join(repositories, `${FIXTURE_LANGUAGE_PLUGIN.repository}.git`)
  await writeFixtureLanguagePlugin(languageRepository)
  await commitRepository(languageRepository, gitEnvironment)
  await copyLaunchPlugin(
    repositories,
    'orca-multipass-recipes',
    'stablyai.orca-multipass-recipes',
    gitEnvironment
  )

  const marketplaceRepository = join(repositories, 'orca-plugins.git')
  await mkdir(marketplaceRepository, { recursive: true })
  await writeFile(
    join(marketplaceRepository, 'orca-marketplace.json'),
    `${JSON.stringify(
      {
        name: 'Orca Plugins',
        owner: 'stablyai',
        plugins: [
          [FIXTURE_LANGUAGE_PLUGIN.pluginKey, FIXTURE_LANGUAGE_PLUGIN.repository, 'languages'],
          ['stablyai.orca-multipass-recipes', 'orca-multipass-recipes', 'vm-recipes']
        ].map(([id, repository, category]) => ({
          id,
          source: {
            kind: 'git',
            url: `https://github.com/stablyai/${repository}.git`,
            ref: 'v1.0.0'
          },
          categories: [category]
        }))
      },
      null,
      2
    )}\n`
  )
  await commitRepository(marketplaceRepository, gitEnvironment)

  return {
    root,
    home,
    gitEnvironment
  }
}

async function openPluginSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'plugins', repoId: null })
    state.openSettingsPage()
  })
  await expect(page.locator('[data-settings-section="plugins"]')).toBeVisible()
}

async function backToPluginList(page: Page): Promise<void> {
  await page.getByRole('article').getByRole('button', { name: 'Plugins', exact: true }).click()
  await expect(page.getByRole('article')).toBeHidden()
}

/** Installs from the plugin's page: one click for content only, else the inline consent. */
async function installMarketplacePluginThroughUi(
  page: Page,
  pluginKey: string,
  pluginName: string,
  { runsInstructions }: { runsInstructions: boolean }
): Promise<void> {
  const listing = page.locator(`[data-plugin-key="${pluginKey}"]`)
  await expect(listing).toBeVisible()
  // Why the page: an older catalog vouches for no profile, so the card asks for review first.
  await listing.getByRole('button', { name: /^Review and install / }).click()
  await expect(page.locator('#plugin-detail-heading')).toContainText(pluginName)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  if (runsInstructions) {
    const consent = page.locator('[data-plugin-consent]')
    await expect(consent).toContainText('Official · stablyai')
    // Why the page: the one decision sits beside the name, above the consent it grants.
    await page
      .getByRole('article')
      .getByRole('button', { name: /^Install & enable/ })
      .click()
    // Why a second step: recipe command lines are read from the installed files, so they are
    // reviewed on the page after install instead of approved unseen.
    const review = page.locator('[data-plugin-consent]')
    await page
      .getByRole('article')
      .getByRole('button', { name: /^Enable plugin/ })
      .click()
    await expect(review).toBeHidden()
  } else {
    await page.getByRole('button', { name: new RegExp(`^Install .*${pluginName}$`) }).click()
    await expect(
      page.getByRole('button', { name: new RegExp(`^More actions for .*${pluginName}$`) })
    ).toBeVisible()
  }
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await backToPluginList(page)
}

async function applyInstalledLanguage(page: Page): Promise<void> {
  const languageId = `plugin:${FIXTURE_LANGUAGE_PLUGIN.pluginKey}/${FIXTURE_LANGUAGE_PLUGIN.locale}`
  await page.evaluate(() => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('store unavailable')
    }
    state.openSettingsTarget({ pane: 'appearance', repoId: null })
  })
  await expect(page.locator('[data-settings-section="appearance"]')).toBeVisible()
  await page.evaluate(() => window.__store?.setState({ settingsSearchQuery: 'Language' }))
  await page.getByRole('combobox', { name: 'Language' }).click()
  await page
    .getByRole('option', {
      name: `${FIXTURE_LANGUAGE_PLUGIN.locale} — ${FIXTURE_LANGUAGE_PLUGIN.pluginKey}`,
      exact: true
    })
    .click()
  await expect
    .poll(() => page.evaluate(() => window.__store?.getState().settings?.uiLanguage))
    .toBe(languageId)
}

async function runMarketplaceJourney(page: Page): Promise<void> {
  const startedAt = Date.now()
  await openPluginSettings(page)
  // Plugins are on by default, so the page never offers a turn-on action.
  await expect(page.getByRole('button', { name: 'Turn on plugins' })).toHaveCount(0)
  await expect
    .poll(
      () =>
        page.evaluate(async () => ({
          sources: await window.api.plugins.listMarketplaces(),
          listings: await window.api.plugins.listMarketplacePlugins()
        })),
      { timeout: 30_000 }
    )
    .toMatchObject({
      sources: [expect.objectContaining({ official: true, stale: false })],
      listings: expect.arrayContaining([
        expect.objectContaining({ pluginKey: FIXTURE_LANGUAGE_PLUGIN.pluginKey, official: true }),
        expect.objectContaining({ pluginKey: 'stablyai.orca-multipass-recipes', official: true })
      ])
    })

  await installMarketplacePluginThroughUi(
    page,
    FIXTURE_LANGUAGE_PLUGIN.pluginKey,
    FIXTURE_LANGUAGE_PLUGIN.name,
    { runsInstructions: false }
  )
  await installMarketplacePluginThroughUi(
    page,
    'stablyai.orca-multipass-recipes',
    'Multipass VM Recipes',
    { runsInstructions: true }
  )

  await applyInstalledLanguage(page)
  expect(Date.now() - startedAt).toBeLessThan(120_000)
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('installs and applies official Phase 1 content from a fresh profile', async ({}, testInfo) => {
  test.setTimeout(180_000)
  const fixture = await createMarketplaceFixture()
  const session = createRestartSession(testInfo as TestInfo, fixture.gitEnvironment)
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    await runMarketplaceJourney(launched.page)
  } finally {
    if (launched) {
      await session.close(launched.app)
    }
    await session.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})
