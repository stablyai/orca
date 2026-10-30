import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@stablyai/playwright-test'
import { hashPluginTree } from '../../src/main/plugins/plugin-content-hash'
import { pluginManifestSchema } from '../../src/shared/plugins/manifest/plugin-manifest'
import { pluginContributionSummary } from '../../src/shared/plugins/contributions/plugin-contribution-summary'
import { pluginCatalogTypes } from '../../src/shared/plugins/catalog/plugin-catalog-release'
import { PLUGIN_MANIFEST_V2_SINCE } from '../../src/shared/plugins/manifest/plugin-schema-field-docs'
import { createRestartSession } from './helpers/orca-restart'
import {
  commitRepository,
  configureFixtureGit,
  headCommit,
  runGit
} from './helpers/plugin-git-fixture'

const PLUGINS = ['orca-review-notes', 'orca-review-tasks'] as const
// Why: install and update review fetch Git; on a loaded runner that alone outlasts the 10s default.
const GIT_STEP = { timeout: 60_000 }

async function writePlugin(repository: string, id: string, version: string): Promise<void> {
  await mkdir(repository, { recursive: true })
  await writeFile(
    join(repository, 'orca-plugin.json'),
    JSON.stringify({
      manifestVersion: 2,
      id,
      publisher: 'stablyai',
      name: id === PLUGINS[0] ? 'Review Notes' : 'Review Tasks',
      version,
      execution: version === '1.0.0' ? 'data' : 'trusted-worker',
      engines: { orca: `>=${PLUGIN_MANIFEST_V2_SINCE}` },
      ...(version === '1.0.0' ? {} : { main: 'worker.mjs' }),
      contributes:
        id === PLUGINS[0]
          ? { iconThemes: [{ id: 'review', title: 'Review Icons', path: 'icons.json' }] }
          : { terminalThemes: [{ id: 'review', title: 'Review Terminal', path: 'terminal.json' }] },
      capabilities: []
    })
  )
  await writeFile(
    join(repository, 'icons.json'),
    JSON.stringify({ schemaVersion: 1, icons: { file: 'file.svg' } })
  )
  await writeFile(
    join(repository, 'file.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#888888"/></svg>'
  )
  await writeFile(
    join(repository, 'terminal.json'),
    JSON.stringify({
      schemaVersion: 1,
      mode: 'light',
      terminal: { background: '#eeeeee', foreground: '#181818', red: '#ff0000' }
    })
  )
  if (version !== '1.0.0') {
    await writeFile(join(repository, 'worker.mjs'), 'export function activate() {}\n')
  }
}

async function publishCatalog(
  repositories: string,
  gitEnvironment: Record<string, string>,
  version: string
): Promise<void> {
  const plugins = await Promise.all(
    PLUGINS.map(async (id) => {
      const repository = join(repositories, `${id}.git`)
      const manifest = pluginManifestSchema.parse(
        JSON.parse(await readFile(join(repository, 'orca-plugin.json'), 'utf8'))
      )
      const tree = await hashPluginTree(repository)
      if (!tree.ok) {
        throw new Error(tree.error)
      }
      return {
        id: `stablyai.${id}`,
        source: { kind: 'git', url: `https://github.com/stablyai/${id}.git`, ref: 'main' },
        categories: ['themes'],
        releases: [
          {
            version,
            name: manifest.name,
            commit: await headCommit(repository, gitEnvironment),
            contentHash: tree.hash,
            execution: manifest.manifestVersion === 2 ? manifest.execution : 'data',
            minimumOrca: PLUGIN_MANIFEST_V2_SINCE,
            types: pluginCatalogTypes(manifest),
            contributes: pluginContributionSummary(manifest),
            capabilities: []
          }
        ]
      }
    })
  )
  await writeFile(
    join(repositories, 'orca-plugins.git', 'orca-catalog.json'),
    JSON.stringify({ catalogVersion: 2, name: 'Orca Plugins', owner: 'stablyai', plugins })
  )
}

// oxlint-disable-next-line no-empty-pattern -- Playwright passes fixtures before testInfo.
test('confirms card removal and shares single/bulk update review without stranding the review queue', async ({}, testInfo) => {
  // Why: one Electron launch drives two Git-backed installs and an update review.
  test.setTimeout(240_000)
  const root = await mkdtemp(join(tmpdir(), 'orca-update-review-'))
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
  const session = createRestartSession(testInfo, { ...gitEnvironment, ORCA_BACKGROUND_LAUNCH: '1' })
  let launched: Awaited<ReturnType<typeof session.launch>> | null = null
  try {
    launched = await session.launch()
    const { page, app } = launched
    expect(await app.evaluate(({ app }) => app.getAppPath())).toBe(process.cwd())
    await page.evaluate(() => {
      const state = window.__store?.getState()
      state?.openSettingsTarget({ pane: 'plugins', repoId: null })
      state?.openSettingsPage()
    })
    const appearanceBefore = await page.evaluate(() => {
      const settings = window.__store?.getState().settings
      return {
        icon: settings?.pluginIconTheme,
        terminal: settings?.terminalThemeLight,
        app: settings?.pluginAppTheme
      }
    })
    for (const id of PLUGINS) {
      await page.locator(`[data-plugin-key="stablyai.${id}"] [data-plugin-row-name]`).click()
      await page.getByRole('button', { name: /^Install / }).click()
      const themeName = id === PLUGINS[0] ? 'Review Icons' : 'Review Terminal'
      const use = page.getByRole('button', { name: `Use now: ${themeName}`, exact: true })
      await expect(use).toBeVisible(GIT_STEP)
      const chosen = (key: string) =>
        page.evaluate((pluginId) => {
          const settings = window.__store?.getState().settings
          return pluginId === 'orca-review-notes'
            ? settings?.pluginIconTheme
            : settings?.terminalThemeLight
        }, key)
      // Installing by click applies the theme at once; its toast offers one click back.
      await expect.poll(() => chosen(id)).toBe(`plugin:stablyai.${id}/review`)
      await expect(use).toHaveAttribute('aria-pressed', 'true')
      await expect(page.getByText(`Now using ${themeName}`, { exact: true })).toBeVisible()
      // Why dispatch: Sonner restacks toasts off-screen as others arrive, so a pointer click can miss.
      await page.getByRole('button', { name: 'Switch back', exact: true }).dispatchEvent('click')
      await expect
        .poll(() =>
          page.evaluate(() => {
            const settings = window.__store?.getState().settings
            return {
              icon: settings?.pluginIconTheme,
              terminal: settings?.terminalThemeLight,
              app: settings?.pluginAppTheme
            }
          })
        )
        .toEqual(appearanceBefore)
      await expect(use).toHaveAttribute('aria-pressed', 'false')
      await use.click()
      await expect(use).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(() => chosen(id)).toBe(`plugin:stablyai.${id}/review`)
      if (id !== PLUGINS[0]) {
        await expect
          .poll(() =>
            page.evaluate(() => window.__store?.getState().settings?.terminalUseSeparateLightTheme)
          )
          .toBe(true)
      }
      await page.getByRole('article').getByRole('button', { name: 'Plugins', exact: true }).click()
      Object.assign(
        appearanceBefore,
        await page.evaluate(() => {
          const settings = window.__store?.getState().settings
          return {
            icon: settings?.pluginIconTheme,
            terminal: settings?.terminalThemeLight,
            app: settings?.pluginAppTheme
          }
        })
      )
    }
    // Why first: the installed row at the top of All repeats the catalog card.
    const notes = page.locator(`[data-plugin-key="stablyai.${PLUGINS[0]}"]`).first()
    await notes.getByRole('button', { name: 'More actions for Review Notes', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Remove…', exact: true }).click()
    const confirmation = page.getByRole('dialog', { name: 'Remove Review Notes?' })
    await expect(confirmation).toContainText('Its data is removed too.')
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(
      notes.getByRole('button', { name: 'More actions for Review Notes', exact: true })
    ).toBeVisible()

    for (const id of PLUGINS) {
      const repository = join(repositories, `${id}.git`)
      await writePlugin(repository, id, '2.0.0')
      await runGit(repository, ['add', '--all'], gitEnvironment)
      await runGit(
        repository,
        [
          '-c',
          'user.name=Orca Test',
          '-c',
          'user.email=orca-test@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'worker update'
        ],
        gitEnvironment
      )
    }
    await publishCatalog(repositories, gitEnvironment, '2.0.0')
    await runGit(marketplace, ['add', '--all'], gitEnvironment)
    await runGit(
      marketplace,
      [
        '-c',
        'user.name=Orca Test',
        '-c',
        'user.email=orca-test@example.invalid',
        'commit',
        '--quiet',
        '-m',
        'publish updates'
      ],
      gitEnvironment
    )
    await page.getByRole('button', { name: 'Refresh catalogs', exact: true }).click()
    await notes.getByRole('button', { name: 'Update Review Notes to 2.0.0', exact: true }).click()
    const update = page.getByRole('dialog', { name: /^Update \d plugins?$/ })
    await expect(update).toHaveAccessibleName('Update 1 plugin')
    await expect(update.locator('[data-plugin-update]')).toHaveCount(1, GIT_STEP)
    // Only what's new shows; the rest of its access waits behind "See all access".
    await expect(update).toContainText(
      'New: Full access: runs as a normal program and can read your files, use the network and run other programs.'
    )
    await expect(update.getByRole('button', { name: 'See all access' })).toBeVisible()
    await update.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.getByRole('tab', { name: /^Updates/ }).click()
    await page.getByRole('button', { name: 'Update all…', exact: true }).click()
    await expect(update.locator('[data-plugin-update]')).toHaveCount(2, GIT_STEP)
    await expect(update).toHaveAccessibleName('Update 2 plugins')
    await expect(update.getByRole('button', { name: 'Update', exact: true })).toBeEnabled()
    await update.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(update).toBeHidden(GIT_STEP)
    await expect(page.locator('#plugin-detail-heading')).toHaveText('Review Notes')
    await page.getByRole('article').getByRole('button', { name: 'Plugins', exact: true }).click()
    await page
      .locator(`[data-plugin-key="stablyai.${PLUGINS[0]}"]`)
      .first()
      .getByRole('button', { name: 'Review', exact: true })
      .click()
    await expect(page.locator('#plugin-detail-heading')).toHaveText('Review Notes')
    await page.keyboard.press('Alt+ArrowLeft')
    await expect(page.getByRole('article')).toBeHidden()
    await page
      .locator(`[data-plugin-key="stablyai.${PLUGINS[0]}"]`)
      .first()
      .getByRole('button', { name: 'Review', exact: true })
      .click()
    await page.getByRole('button', { name: 'Keep off', exact: true }).click()
    await expect(page.locator('#plugin-detail-heading')).toHaveText('Review Tasks')
    await page.getByRole('button', { name: 'Keep off', exact: true }).click()
  } finally {
    await session.dispose(launched?.app)
    await rm(root, { recursive: true, force: true })
  }
})
