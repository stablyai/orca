import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@stablyai/playwright-test'
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
const FULL_ACCESS =
  'Full access: runs as a normal program and can read your files, use the network and run other programs.'

/** Each fixture plugin's installed version and whether it waits on the page's review queue. */
async function installedState(page: Page): Promise<{ version: string; review: boolean }[]> {
  return page.evaluate(async (ids) => {
    const plugins = await window.api.plugins.list()
    return ids.map((id) => {
      const plugin = plugins.find((entry) => entry.pluginKey === `stablyai.${id}`)
      return {
        version: plugin?.version ?? 'missing',
        review: Boolean(plugin && (plugin.needsReconsent || plugin.status === 'pending'))
      }
    })
  }, PLUGINS)
}

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
test('confirms card removal, reviews a lone access-growing update directly, and approves each of several from the list', async ({}, testInfo) => {
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
    // A lone update that grows access skips the list and opens straight into its own review.
    const single = page.getByRole('dialog', { name: 'Review update to Review Notes', exact: true })
    const singleReview = single.locator(`[data-plugin-update-review="stablyai.${PLUGINS[0]}"]`)
    await expect(singleReview).toBeVisible(GIT_STEP)
    await expect(single.locator('[data-plugin-update]')).toHaveCount(0)
    await expect(singleReview).toContainText(
      'This update asks for more than the version you approved. It installs only if you approve it here.'
    )
    await expect(singleReview.locator('[data-added]', { hasText: FULL_ACCESS })).toBeVisible()
    await expect(singleReview.getByRole('button', { name: 'See all access' })).toBeVisible()
    await expect(single.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0)
    await single.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(single).toBeHidden()
    expect(await installedState(page)).toEqual(
      PLUGINS.map(() => ({ version: '1.0.0', review: false }))
    )

    await page.getByRole('tab', { name: /^Updates/ }).click()
    await page.getByRole('button', { name: 'Update all…', exact: true }).click()
    const list = page.getByRole('dialog', { name: 'Update 2 plugins', exact: true })
    await expect(list.locator('[data-plugin-update]')).toHaveCount(2, GIT_STEP)
    for (const id of PLUGINS) {
      const row = list.locator(`[data-plugin-update="stablyai.${id}"]`)
      // Only what's new shows; the rest of its access waits behind "See all access".
      await expect(row).toContainText(`New: ${FULL_ACCESS}`)
      await expect(row.getByRole('button', { name: 'See all access' })).toBeVisible()
      // Access-growing updates trade the bulk checkbox for their own Review.
      await expect(row.getByRole('checkbox')).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Review', exact: true })).toBeEnabled()
    }
    await expect(list.getByRole('button', { name: 'Update', exact: true })).toBeDisabled()

    const notesRow = list.locator(`[data-plugin-update="stablyai.${PLUGINS[0]}"]`)
    await notesRow.getByRole('button', { name: 'Review', exact: true }).click()
    const notesReview = page.getByRole('dialog', { name: 'Review update to Review Notes' })
    await expect(
      notesReview.locator(`[data-plugin-update-review="stablyai.${PLUGINS[0]}"]`)
    ).toBeVisible()
    // Back from one review returns to the list without installing anything.
    await notesReview.getByRole('button', { name: 'Back', exact: true }).click()
    await expect(list.locator('[data-plugin-update]')).toHaveCount(2)
    expect(await installedState(page)).toEqual(
      PLUGINS.map(() => ({ version: '1.0.0', review: false }))
    )

    for (const [index, id] of PLUGINS.entries()) {
      const name = index === 0 ? 'Review Notes' : 'Review Tasks'
      const row = list.locator(`[data-plugin-update="stablyai.${id}"]`)
      await row.getByRole('button', { name: 'Review', exact: true }).click()
      const review = page.getByRole('dialog', { name: `Review update to ${name}`, exact: true })
      await expect(review.locator(`[data-plugin-update-review="stablyai.${id}"]`)).toBeVisible()
      await review.getByRole('button', { name: 'Approve & update', exact: true }).click()
      // Approving one of several returns to the list, which keeps the rest pending.
      await expect(row).toContainText('Updated', GIT_STEP)
      await expect(row.getByRole('button', { name: 'Review', exact: true })).toBeDisabled()
    }
    // Why the footer: the dialog's corner X is also named Close; the footer one reflects progress.
    await list
      .locator('[data-slot="dialog-footer"]')
      .getByRole('button', { name: 'Close', exact: true })
      .click()
    await expect(list).toBeHidden()
    // Approval covered exactly the reviewed bytes, so nothing lands in the page's review queue.
    expect(await installedState(page)).toEqual(
      PLUGINS.map(() => ({ version: '2.0.0', review: false }))
    )
    await expect(page.locator('#plugin-detail-heading')).toBeHidden()
    await expect(
      page.locator('[data-plugin-key^="stablyai.orca-review-"]').getByRole('button', {
        name: 'Review',
        exact: true
      })
    ).toHaveCount(0)
  } finally {
    await session.dispose(launched?.app)
    await rm(root, { recursive: true, force: true })
  }
})
